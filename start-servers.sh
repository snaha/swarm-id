#!/bin/bash

# Start local servers for Swarm ID development
#
# This script starts TWO servers:
#   1. server-app.js (port 8080) - Serves demo HTML files
#   2. server-id.js (port 8081)  - Serves SvelteKit app
#
# Prerequisites:
#   - Library must be built: cd lib && pnpm build
#   - SvelteKit app (optional): cd swarm-ui && pnpm build
#     (If not built, demo/proxy pages won't have identity UI)
#
# For SvelteKit development with hot reload, use: ./start-servers-dev.sh

echo "========================================================================"
echo "Starting Swarm ID Local Servers"
echo "========================================================================"
echo ""
echo "This starts TWO HTTPS servers:"
echo "  - https://swarm-app.local:8080  (demo app)"
echo "  - https://swarm-id.local:8081   (identity app + proxy)"
echo ""
echo "Library files are served from lib/dist/ (build library with: cd lib && pnpm build)"
echo "Optional: Build SvelteKit UI first with: cd swarm-ui && pnpm build"
echo ""
echo "Note: You'll see browser security warnings due to self-signed certs."
echo "      Click 'Advanced' and 'Accept Risk' to proceed (safe for local dev)"
echo ""
echo "Press Ctrl+C to stop both servers"
echo "========================================================================"
echo ""

# Check if /etc/hosts is configured
if ! grep -q "swarm-app.local" /etc/hosts || ! grep -q "swarm-id.local" /etc/hosts; then
    echo "⚠️  WARNING: Domains not found in /etc/hosts"
    echo ""
    echo "Please add the following lines to /etc/hosts:"
    echo ""
    echo "127.0.0.1  swarm-app.local"
    echo "127.0.0.1  swarm-id.local"
    echo ""
    echo "Run this command:"
    echo ""
    echo "  sudo bash -c 'echo \"\" >> /etc/hosts && echo \"# Swarm local development domains\" >> /etc/hosts && echo \"127.0.0.1  swarm-app.local\" >> /etc/hosts && echo \"127.0.0.1  swarm-id.local\" >> /etc/hosts'"
    echo ""
    read -p "Press Enter to continue anyway, or Ctrl+C to exit and configure /etc/hosts first..."
    echo ""
fi

# Trap Ctrl+C to kill both servers
trap 'echo ""; echo "Stopping servers..."; kill $PID_APP $PID_ID 2>/dev/null; exit' INT TERM

# Start app server in background
node server-app.js &
PID_APP=$!

# Give it a moment to start
sleep 1

# Start id server in background
node server-id.js &
PID_ID=$!

# Wait for both processes
echo ""
echo "========================================================================"
echo "✓ Both HTTPS servers started!"
echo "========================================================================"
echo ""
echo "Access demos:"
echo "  • Landing:      https://swarm-app.local:8080/"
echo "  • Library demo: https://swarm-app.local:8080/demo/demo.html"
echo "  • Popup demo:   https://swarm-app.local:8080/popup/demo.html"
echo ""
echo "Identity app:"
echo "  • UI:    https://swarm-id.local:8081/"
echo "  • Proxy: https://swarm-id.local:8081/proxy (SvelteKit route, used by iframe)"
echo ""
echo "IMPORTANT: Accept security warnings in your browser for BOTH domains!"
echo ""
echo "Press Ctrl+C to stop both servers"
echo "========================================================================"
echo ""

# Wait for both background processes
wait $PID_APP $PID_ID
