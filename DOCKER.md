# Docker Development Setup

This directory contains Docker configuration for running the Swarm ID development environment with a single command.

## Quick Start

```bash
# 1. Add domains to /etc/hosts (one-time setup)
sudo bash -c 'echo "127.0.0.1 swarm-app.local swarm-id.local" >> /etc/hosts'

# 2. Start everything
docker compose up

# 3. Access the apps
# Demo App: https://swarm-app.local:8080/
# Identity UI: https://swarm-id.local:8081/
```

## What's Included

The Docker setup includes:
- ✅ Automatic SSL certificate generation with mkcert
- ✅ SvelteKit dev server with hot reload (port 5174)
- ✅ Demo app server (port 8080)
- ✅ Identity proxy server (port 8081)
- ✅ All dependencies pre-installed
- ✅ Volume mounts for live code changes

## Architecture

```
┌─────────────────────────────────────────────┐
│ Docker Container (swarm-id-dev)             │
│                                             │
│  ┌────────────────────────────────────┐    │
│  │ SvelteKit Dev Server (5174)        │    │
│  │  - Hot reload enabled              │    │
│  │  - Watches /app/swarm-ui/src       │    │
│  └────────────────────────────────────┘    │
│                                             │
│  ┌────────────────────────────────────┐    │
│  │ Demo Server (8080)                 │    │
│  │  - Serves demo files               │    │
│  │  - HTTPS with mkcert certs         │    │
│  └────────────────────────────────────┘    │
│                                             │
│  ┌────────────────────────────────────┐    │
│  │ Identity Proxy (8081)              │    │
│  │  - Proxies to localhost:5174       │    │
│  │  - HTTPS with mkcert certs         │    │
│  └────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
         │                    │
         │ Port mapping       │
         ▼                    ▼
    8080:8080            8081:8081
    (Demo HTTPS)         (Identity HTTPS)
```

## Commands

### Start services
```bash
docker compose up
```

### Start in background
```bash
docker compose up -d
```

### Stop services
```bash
docker compose down
```

### View logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f swarm-dev
```

### Rebuild after dependency changes
```bash
docker compose build
docker compose up
```

### Shell into container
```bash
docker compose exec swarm-dev bash
```

## Hot Reload

Changes to the following directories are automatically reflected:
- `lib/src/**/*` - Library source (requires manual rebuild: see below)
- `swarm-ui/src/**/*` - SvelteKit UI (auto-reload via Vite)
- `demo/**/*` - Demo files (served directly)

### Rebuilding library in container

If you modify library source code:

```bash
docker compose exec swarm-dev sh -c "cd /app/lib && pnpm build"
```

## Troubleshooting

### Cannot access swarm-app.local
- Make sure /etc/hosts is configured on your **host machine** (not in container)
- Run: `grep swarm /etc/hosts` to verify

### SSL certificate warnings
- This is expected with self-signed certificates
- Click "Advanced" → "Accept Risk and Continue" in your browser
- Safe for local development

### Port already in use
- Check if ports 8080, 8081, or 5174 are used by other processes
- Stop those processes or use different ports

### Hot reload not working
- On Mac/Windows, ensure Docker Desktop has file sharing enabled
- Check volume mounts: `docker compose config`

### Performance issues
- Allocate more resources to Docker Desktop (Settings → Resources)
- Consider using manual setup on Mac/Windows for better performance

## Files

- `Dockerfile` - Development environment image
- `docker-compose.yml` - Service orchestration
- `docker-entrypoint.sh` - Container startup script
- `.dockerignore` - Files excluded from build

## Comparison with Manual Setup

**Docker:**
- ✅ One command to start everything
- ✅ No manual dependency installation
- ✅ Consistent environment across machines
- ❌ Slightly slower on Mac/Windows (VM overhead)
- ❌ Requires Docker Desktop

**Manual:**
- ✅ Native performance
- ✅ More control over each component
- ❌ Multiple terminal windows needed
- ❌ Manual dependency management
- ❌ Requires mkcert, Node.js, pnpm installed

## Next Steps

After starting the Docker environment:
1. Open https://swarm-app.local:8080/ in your browser
2. Accept security warnings for both domains
3. Click "Connect" to authenticate
4. Try uploading and downloading data

For more information, see the main [README.md](../README.md).
