#!/bin/bash

# Make sure we are in the repo root
echo "Running frontend fix script..."

# Step 1: Backup frontend just in case
# if [ -d "frontend" ]; then
#     echo "Backing up frontend folder..."
#     cp -r frontend frontend_backup
# fi

# Step 2: Remove submodule from git
echo "Removing frontend submodule from git index..."
git rm --cached frontend

# Step 3: Remove frontend section from .gitmodules if it exists
if [ -f ".gitmodules" ]; then
    echo "Removing frontend from .gitmodules..."
    git config -f .gitmodules --remove-section submodule.frontend
    git add .gitmodules
fi

# Step 4: Remove submodule config from git
git config --remove-section submodule.frontend 2>/dev/null || true

# Step 5: Remove submodule metadata
if [ -d ".git/modules/frontend" ]; then
    echo "Removing submodule metadata..."
    rm -rf .git/modules/frontend
fi

# Step 6: Re-add frontend as a normal folder
echo "Adding frontend folder as normal folder..."
git add frontend

# Step 7: Commit changes
git commit -m "Convert frontend from submodule to normal folder"

# Step 8: Push to remote
git push origin main

echo "Frontend folder should now be a normal folder and pushed to remote!"
