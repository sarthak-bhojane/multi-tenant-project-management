// server.js
const express = require("express");
const { ApolloServer, gql } = require("apollo-server-express");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const PORT = 4000;
const JWT_SECRET = "super_secret_jwt_key"; // use .env in production

// ---------------------- PostgreSQL Pool ----------------------
// const pool = new Pool({
//   user: "postgres",
//   host: "localhost", 
//   host: "dpg-d3aqonvfte5s7398flkg-a",
//   database: "multitenant-project-mgmt",
//   password: "Sarthak@2002",
//   port: 5432,
// });


const pool = new Pool({
  user: "multitenantprojectmgmt_user",
  host: "dpg-d3aqonvfte5s7398flkg-a.oregon-postgres.render.com",
  database: "multitenantprojectmgmt",
  password: "PtrIS9ubosfj1Ywg0gY0ugdQvn75lTui",
  port: 5432,
  ssl: {
    rejectUnauthorized: false, // necessary for Render external Postgres
  },
});

// ---------------------- GraphQL TypeDefs ----------------------
const typeDefs = gql`
  type Organization {
    id: ID!
    name: String!
    slug: String!
    contact_email: String
    password: String
    created_at: String
  }

  type Project {
    id: ID!
    organization_id: ID!
    name: String!
    description: String
    status: String
    due_date: String
    created_at: String
    taskCount: Int!
    completedTasks: Int!
    tasks: [Task!]!                 # NEW: include tasks for convenience
  }

  type Task {
    id: ID!
    project_id: ID!
    title: String!
    description: String
    status: String
    assignee_email: String
    due_date: String
    created_at: String
    comments: [TaskComment!]!
  }

  type TaskComment {
    id: ID!
    task_id: ID!
    content: String!
    author_email: String
    timestamp: String
  }

  type ProjectStats {
    projectId: ID!
    taskCount: Int!
    completedTasks: Int!
    completionRate: Float!
  }

  type AuthPayload {
    token: String!
    role: String!
  }

  input ProjectInput {
    id: ID
    name: String!
    description: String
    status: String
    due_date: String
  }

  input TaskInput {
    id: ID
    project_id: ID        # made optional for updates
    title: String
    description: String
    status: String
    assignee_email: String
    due_date: String
  }

  type Query {
    listOrganizations: [Organization!]!
    listProjects: [Project!]!
    listTasks(projectId: ID!): [Task!]!
    projectStats: [ProjectStats!]!
  }

  type Mutation {
    superAdminLogin(password: String!): AuthPayload!
    organizationLogin(slug: String!, password: String!): AuthPayload!
    createOrganization(name: String!, slug: String!, contact_email: String, password: String!): Organization!
    createOrUpdateProject(input: ProjectInput!): Project!
    createOrUpdateTask(input: TaskInput!): Task!
    addComment(taskId: ID!, content: String!, author_email: String): TaskComment!
  }
`;

// ---------------------- Helper functions ----------------------
async function getOrgBySlug(slug) {
  const res = await pool.query("SELECT * FROM organizations WHERE slug=$1", [slug]);
  if (!res.rows[0]) throw new Error("Organization not found");
  return res.rows[0];
}

// ---------------------- Resolvers ----------------------
const resolvers = {
  Query: {
    listOrganizations: async (_, __, { user }) => {
      if (!user || user.role !== "SUPER_ADMIN") throw new Error("Unauthorized");
      const res = await pool.query("SELECT id, name, slug, contact_email, created_at FROM organizations ORDER BY created_at DESC");
      return res.rows;
    },

    listProjects: async (_, __, { user }) => {
      if (!user) throw new Error("Unauthorized");
      let query = "SELECT * FROM projects";
      let values = [];
      if (user.role === "ORG") {
        query += " WHERE organization_id=$1 ORDER BY created_at DESC";
        values = [user.orgId];
      } else {
        query += " ORDER BY created_at DESC";
      }
      const res = await pool.query(query, values);
      return res.rows;
    },

    listTasks: async (_, { projectId }, { user }) => {
      if (!user) throw new Error("Unauthorized");
      // check project exists and belongs to org (if ORG)
      const projRes = await pool.query("SELECT * FROM projects WHERE id=$1", [projectId]);
      if (!projRes.rows[0]) return [];
      if (user.role === "ORG" && projRes.rows[0].organization_id !== user.orgId) return [];
      const res = await pool.query("SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at ASC", [projectId]);
      return res.rows;
    },

    projectStats: async (_, __, { user }) => {
      if (!user || user.role !== "ORG") throw new Error("Unauthorized");
      const projects = await pool.query("SELECT * FROM projects WHERE organization_id=$1", [user.orgId]);
      const stats = [];
      for (let p of projects.rows) {
        const tasks = await pool.query("SELECT * FROM tasks WHERE project_id=$1", [p.id]);
        const completed = tasks.rows.filter((t) => t.status === "DONE").length;
        stats.push({
          projectId: p.id,
          taskCount: tasks.rows.length,
          completedTasks: completed,
          completionRate: tasks.rows.length ? completed / tasks.rows.length : 0,
        });
      }
      return stats;
    },
  },

  Mutation: {
    superAdminLogin: async (_, { password }) => {
      const SUPER_ADMIN_PASSWORD = "superadmin@123";
      if (password !== SUPER_ADMIN_PASSWORD) throw new Error("Invalid password");
      const token = jwt.sign({ role: "SUPER_ADMIN" }, JWT_SECRET, { expiresIn: "4h" });
      return { token, role: "SUPER_ADMIN" };
    },

    organizationLogin: async (_, { slug, password }) => {
      const org = await getOrgBySlug(slug);
      const valid = await bcrypt.compare(password, org.password);
      if (!valid) throw new Error("Invalid credentials");
      const token = jwt.sign({ role: "ORG", orgId: org.id }, JWT_SECRET, { expiresIn: "4h" });
      return { token, role: "ORG" };
    },

    createOrganization: async (_, { name, slug, contact_email, password }, { user }) => {
      if (!user || user.role !== "SUPER_ADMIN") throw new Error("Unauthorized");
      const hashedPassword = await bcrypt.hash(password, 10);
      const id = uuidv4();
      const created_at = new Date().toISOString();
      await pool.query(
        "INSERT INTO organizations (id,name,slug,contact_email,password,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, name, slug, contact_email, hashedPassword, created_at]
      );
      return { id, name, slug, contact_email, created_at };
    },

    createOrUpdateProject: async (_, { input }, { user }) => {
      if (!user) throw new Error("Unauthorized");
      if (input.id) {
        // ensure project belongs to org (if ORG)
        if (user.role === "ORG") {
          const p = await pool.query("SELECT * FROM projects WHERE id=$1 AND organization_id=$2", [input.id, user.orgId]);
          if (!p.rows[0]) throw new Error("Project not found for this org");
        }
        await pool.query(
          "UPDATE projects SET name=$1, description=$2, status=$3, due_date=$4 WHERE id=$5",
          [input.name, input.description, input.status, input.due_date, input.id]
        );
        const res = await pool.query("SELECT * FROM projects WHERE id=$1", [input.id]);
        return res.rows[0];
      } else {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        if (user.role !== "ORG") throw new Error("Only org users can create projects");
        await pool.query(
          "INSERT INTO projects (id,organization_id,name,description,status,due_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [id, user.orgId, input.name, input.description, input.status, input.due_date, created_at]
        );
        return { id, organization_id: user.orgId, ...input, created_at };
      }
    },

    createOrUpdateTask: async (_, { input }, { user }) => {
      if (!user) throw new Error("Unauthorized");

      // If creating new task, ensure project belongs to org
      if (!input.id) {
        if (!input.project_id) throw new Error("project_id required for new task");
        const proj = await pool.query("SELECT * FROM projects WHERE id=$1", [input.project_id]);
        if (!proj.rows[0]) throw new Error("Project not found");
        if (user.role === "ORG" && proj.rows[0].organization_id !== user.orgId) throw new Error("Unauthorized to create task for this project");
        const id = uuidv4();
        const created_at = new Date().toISOString();
        await pool.query(
          "INSERT INTO tasks (id,project_id,title,description,status,assignee_email,due_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id,
            input.project_id,
            input.title || "",
            input.description || "",
            input.status || "ACTIVE",
            input.assignee_email || null,
            input.due_date || null,
            created_at,
          ]
        );
        const res = await pool.query("SELECT * FROM tasks WHERE id=$1", [id]);
        return res.rows[0];
      } else {
        // Updating existing task: validate ownership
        // find task and its project
        const tRes = await pool.query("SELECT t.*, p.organization_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id=$1", [input.id]);
        if (!tRes.rows[0]) throw new Error("Task not found");
        if (user.role === "ORG" && tRes.rows[0].organization_id !== user.orgId) throw new Error("Unauthorized to update this task");

        // Build dynamic update
        const fields = [];
        const values = [];
        let idx = 1;

        if (input.title !== undefined) { fields.push(`title=$${idx++}`); values.push(input.title); }
        if (input.description !== undefined) { fields.push(`description=$${idx++}`); values.push(input.description); }
        if (input.status !== undefined) { fields.push(`status=$${idx++}`); values.push(input.status); }
        if (input.assignee_email !== undefined) { fields.push(`assignee_email=$${idx++}`); values.push(input.assignee_email); }
        if (input.due_date !== undefined) { fields.push(`due_date=$${idx++}`); values.push(input.due_date); }
        // If project_id provided (moving task), validate and set
        if (input.project_id !== undefined) {
          const proj = await pool.query("SELECT * FROM projects WHERE id=$1", [input.project_id]);
          if (!proj.rows[0]) throw new Error("Target project not found");
          if (user.role === "ORG" && proj.rows[0].organization_id !== user.orgId) throw new Error("Unauthorized target project");
          fields.push(`project_id=$${idx++}`); values.push(input.project_id);
        }

        if (fields.length === 0) {
          // nothing to update
          const current = await pool.query("SELECT * FROM tasks WHERE id=$1", [input.id]);
          return current.rows[0];
        }

        values.push(input.id); // last param for WHERE
        const sql = `UPDATE tasks SET ${fields.join(", ")} WHERE id=$${idx} RETURNING *`;
        const updated = await pool.query(sql, values);
        return updated.rows[0];
      }
    },

    addComment: async (_, { taskId, content, author_email }, { user }) => {
      if (!user) throw new Error("Unauthorized");
      // check task exists and belongs to user's org (if ORG)
      const q = await pool.query("SELECT t.*, p.organization_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id=$1", [taskId]);
      if (!q.rows[0]) throw new Error("Task not found");
      if (user.role === "ORG" && q.rows[0].organization_id !== user.orgId) throw new Error("Unauthorized to comment on this task");

      const id = uuidv4();
      const timestamp = new Date().toISOString();
      await pool.query("INSERT INTO task_comments (id,task_id,content,author_email,timestamp) VALUES ($1,$2,$3,$4,$5)",
        [id, taskId, content, author_email || null, timestamp]
      );
      return { id, task_id: taskId, content, author_email, timestamp };
    },
  },

  Project: {
    taskCount: async (p) =>
      parseInt((await pool.query("SELECT COUNT(*) FROM tasks WHERE project_id=$1", [p.id])).rows[0].count),
    completedTasks: async (p) =>
      parseInt((await pool.query("SELECT COUNT(*) FROM tasks WHERE project_id=$1 AND status='DONE'", [p.id])).rows[0].count),
    tasks: async (p) =>
      (await pool.query("SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at ASC", [p.id])).rows,
  },

  Task: {
    comments: async (t) =>
      (await pool.query("SELECT * FROM task_comments WHERE task_id=$1 ORDER BY timestamp ASC", [t.id])).rows,
  },
};

// ---------------------- Initialize DB ----------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE NOT NULL,
      contact_email VARCHAR(255),
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(50),
      due_date TIMESTAMP,
      created_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY,
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(50),
      assignee_email VARCHAR(255),
      due_date TIMESTAMP,
      created_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id UUID PRIMARY KEY,
      task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      author_email VARCHAR(255),
      timestamp TIMESTAMP
    )
  `);

  console.log("✅ Tables ensured");
}

// ---------------------- Start Server ----------------------
async function startServer() {
  const app = express();
  app.use(bodyParser.json());

  await initDB();

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: ({ req }) => {
      const token = req.headers.authorization || "";
      if (token) {
        try {
          const user = jwt.verify(token.replace("Bearer ", ""), JWT_SECRET);
          return { user };
        } catch (err) {
          return {};
        }
      }
      return {};
    },
  });

  await server.start();
  server.applyMiddleware({ app });

  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}/graphql`));
}

startServer();
