#!/bin/bash
set -e

echo "========================================================================"
echo "Swarm ID Development Environment (Docker)"
echo "========================================================================"
echo ""

# Generate SSL certificates if they don't exist
if [ ! -f "swarm-app.local+1.pem" ] || [ ! -f "swarm-app.local+1-key.pem" ]; then
    echo "📜 Generating SSL certificates with mkcert..."
    mkcert -install
    mkcert swarm-app.local swarm-id.local
    echo "✓ SSL certificates generated"
    echo ""
fi

# Build the library first
echo "🔨 Building library..."
cd /app/lib
pnpm build
echo "✓ Library built"
echo ""

cd /app

# Function to start a service with logging
start_service() {
    local name=$1
    local cmd=$2
    echo "🚀 Starting $name..."
    $cmd &
    local pid=$!
    echo "  Started $name (PID: $pid)"
    return $pid
}

echo "========================================================================"
echo "Starting Services"
echo "========================================================================"
echo ""

# Start SvelteKit dev server
echo "🚀 Starting SvelteKit dev server (port 5174)..."
cd /app/swarm-ui
pnpm dev --host 0.0.0.0 --port 5174 &
VITE_PID=$!
echo "  Started SvelteKit (PID: $VITE_PID)"

# Give Vite a moment to start
sleep 3

cd /app

# Start demo app server
echo "🚀 Starting demo app server (port 8080)..."
node server-app.js &
APP_PID=$!
echo "  Started demo server (PID: $APP_PID)"

# Start identity server (proxies to Vite)
echo "🚀 Starting identity proxy server (port 8081)..."
PROXY_TARGET=http://localhost:5174 node server-id.js &
ID_PID=$!
echo "  Started identity server (PID: $ID_PID)"

echo ""
echo "========================================================================"
echo "✓ All services started!"
echo "========================================================================"
echo ""
echo "Access the application:"
echo "  Demo App:     https://swarm-app.local:8080/"
echo "  Identity UI:  https://swarm-id.local:8081/"
echo ""
echo "⚠️  Add to /etc/hosts on your HOST machine:"
echo "    127.0.0.1  swarm-app.local"
echo "    127.0.0.1  swarm-id.local"
echo ""
echo "⚠️  Accept browser security warnings for self-signed certificates"
echo ""
echo "📝 Logs from all services will appear below:"
echo "========================================================================"
echo ""

# Trap SIGTERM and SIGINT to gracefully shutdown
trap "echo ''; echo 'Stopping services...'; kill $VITE_PID $APP_PID $ID_PID 2>/dev/null; exit" SIGTERM SIGINT

# Wait for all background processes
wait $VITE_PID $APP_PID $ID_PID
