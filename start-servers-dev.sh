#!/bin/bash

# Start local development servers with proxy to dev server
#
# This script starts TWO servers:
#   1. server-app.js (port 8080) - Serves demo HTML files
#   2. server-id.js (port 8081)  - Proxies to your dev server (default: localhost:5174)
#
# Usage:
#   ./start-servers-dev.sh                           # Uses default localhost:5174
#   PROXY_TARGET=http://localhost:3000 ./start-servers-dev.sh
#
# Before running:
#   cd swarm-ui && pnpm dev    # Start your SvelteKit dev server first!

PROXY_TARGET="${PROXY_TARGET:-http://localhost:5174}"

echo "========================================================================"
echo "Starting Swarm ID Local Servers (DEV MODE with Hot Reload)"
echo "========================================================================"
echo ""
echo "This starts TWO HTTPS servers:"
echo "  - https://swarm-app.local:8080  (demo app)"
echo "  - https://swarm-id.local:8081   (proxies to ${PROXY_TARGET})"
echo ""
echo "⚠️  IMPORTANT: Make sure SvelteKit dev server is running!"
echo "   Run: cd swarm-ui && pnpm dev"
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

# Start id server with PROXY_TARGET set
PROXY_TARGET="${PROXY_TARGET}" node server-id.js &
PID_ID=$!

# Wait for both processes
echo ""
echo "========================================================================"
echo "✓ Both HTTPS servers started! (DEV MODE)"
echo "========================================================================"
echo ""
echo "Server setup:"
echo "  • Port 8080: Demo app (server-app.js)"
echo "  • Port 8081: Proxies to ${PROXY_TARGET} (server-id.js)"
echo ""
echo "Access demos:"
echo "  • Landing:      https://swarm-app.local:8080/"
echo "  • Library demo: https://swarm-app.local:8080/demo/demo.html"
echo "  • Popup demo:   https://swarm-app.local:8080/popup/demo.html"
echo ""
echo "Identity app (with hot reload):"
echo "  • UI:    https://swarm-id.local:8081/ → ${PROXY_TARGET}"
echo "  • Proxy: https://swarm-id.local:8081/proxy (SvelteKit route)"
echo ""
echo "⚠️  IMPORTANT:"
echo "  1. Make sure 'pnpm dev' is running in swarm-ui/ at ${PROXY_TARGET}"
echo "  2. Accept security warnings in your browser for BOTH domains"
echo ""
echo "Press Ctrl+C to stop both servers"
echo "========================================================================"
echo ""

# Wait for both background processes
wait $PID_APP $PID_ID
