#!/bin/bash

# Start local development servers for Swarm iframe storage demo
# This script starts two Node.js servers on different domains

echo "========================================================================"
echo "Starting Swarm Iframe Storage Demo Servers (HTTPS)"
echo "========================================================================"
echo ""
echo "This will start two HTTPS servers:"
echo "  - https://swarm-app.local:8080  (demo-iframe-storage.html)"
echo "  - https://swarm-id.local:8081   (iframe-storage.html)"
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
echo "Access the demo at:"
echo "  https://swarm-app.local:8080/demo-iframe-storage.html"
echo ""
echo "The iframe will be loaded from:"
echo "  https://swarm-id.local:8081/iframe-storage.html"
echo ""
echo "IMPORTANT: Accept the security warnings in your browser for both domains!"
echo ""
echo "Press Ctrl+C to stop both servers"
echo "========================================================================"
echo ""

# Wait for both background processes
wait $PID_APP $PID_ID
