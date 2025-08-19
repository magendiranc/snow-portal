
#!/bin/bash
set -e

echo "=== Pulling latest code from GitHub ==="
git fetch origin main
git reset --hard origin/main

echo "=== Installing backend dependencies ==="
cd ~/wrapper/backend
npm ci

echo "=== Installing frontend dependencies ==="
cd ~/wrapper/frontend
npm ci

echo "=== Building frontend ==="
npm run build

echo "=== Restarting services with PM2 ==="
pm2 restart snow-backend || pm2 start server.js --name snow-backend
pm2 restart snow-portal || pm2 start npx --name snow-portal -- serve -s dist -l 5173

echo "=== Deployment complete ==="
pm2 list
