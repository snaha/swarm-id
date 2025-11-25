# Deployment Guide

This project is configured as a **pnpm monorepo** for deployment to Digital Ocean App Platform as two separate static sites.

## Project Structure

```
swarm-id-explorations/
├── lib/                   # Swarm ID library (@swarm-id/lib)
├── demo/                  # Demo app package (@swarm-id/demo)
├── swarm-ui/              # SvelteKit identity UI (swarm-identity)
├── bee-js/                # Bee.js library (linked)
├── .do-app-demo.yaml      # DO config for swarm-demo.snaha.net
├── .do-app-id.yaml        # DO config for swarm-id.snaha.net
└── package.json           # Root monorepo config
```

## Deployed Apps

### 1. swarm-demo.snaha.net (Demo App)

**Purpose:** Demonstrates Swarm ID authentication flows

**Builds:**
- `lib/` - Swarm ID library
- `demo/` - Demo HTML pages with bundled library

**Output:** `demo/build/`

**Files:**
- `/index.html` - Landing page with links to both demos
- `/demo.html` - Library demo (SwarmIdClient) - Recommended
- `/auth.html` - Auth page (currently unused)
- `/popup/demo.html` - OAuth-style popup flow demo (Experimental)
- `/popup/auth.html` - Popup auth page
- `/popup/proxy.html` - Popup proxy iframe

**CORS:** Allows requests from `https://swarm-id.snaha.net`

### 2. swarm-id.snaha.net (Identity App)

**Purpose:** Hosts identity management UI and proxy/auth pages

**Builds:**
- `lib/` - Swarm ID library
- `swarm-ui/` - SvelteKit app
- Proxy/auth pages with bundled library

**Output:** `swarm-id-build/`

**Files:**
- `/` - SvelteKit app (identity management UI)
- `/demo/proxy.html` - Iframe proxy for Bee API calls
- `/demo/auth.html` - Auth popup page

**CORS:** Allows requests from `https://swarm-demo.snaha.net`

## Build Commands

### Monorepo Commands

```bash
# Install all dependencies
pnpm install

# Build everything
pnpm build

# Build specific apps
pnpm build:swarm-demo    # Builds lib + demo
pnpm build:swarm-id      # Builds lib + swarm-ui + processes proxy files

# Clean all builds
pnpm clean

# Development
pnpm dev:lib             # Watch mode for library
pnpm dev:swarm-ui        # Dev server for SvelteKit
```

### Individual Package Commands

```bash
# Library
cd lib && pnpm build

# Demo
cd demo && pnpm build

# SvelteKit UI
cd swarm-ui && pnpm build
```

## Deployment Configuration

### Digital Ocean App Platform

**Deploy from GitHub:**
- Repository: `snaha/swarm-id-explorations`
- Branch: `feat/create-swarm-ui` (update to `main` when ready)

**App 1: swarm-demo**
- Config: `.do-app-demo.yaml`
- Build: `pnpm install && pnpm build:swarm-demo`
- Output: `demo/build`
- Domain: `swarm-demo.snaha.net`

**App 2: swarm-id**
- Config: `.do-app-id.yaml`
- Build: `pnpm install && pnpm build:swarm-id`
- Output: `swarm-id-build`
- Domain: `swarm-id.snaha.net`

### Environment Variables

Both apps use these environment variables (injected at build time):

- `APP_DOMAIN` - Demo app domain (default: `https://swarm-demo.snaha.net`)
- `ID_DOMAIN` - Identity app domain (default: `https://swarm-id.snaha.net`)
- `BEE_API_URL` - Bee node URL (default: `http://localhost:1633`)
- `NODE_ENV` - Environment (production)

## How It Works

### Build Process

1. **Library Build** (`lib/`)
   - Rollup bundles TypeScript to ES6 modules
   - Outputs to `lib/dist/`
   - Produces separate module files (not bundled together)
   - Includes TypeScript definitions and source maps

2. **Demo Build** (`demo/build.js`)
   - Copies `lib/dist/` → `demo/build/lib/`
   - Injects environment config into HTML files
   - HTML files use standard `<script type="module">` imports
   - Outputs to `demo/build/`
   - **Result:** Small HTML files (3-12KB) + library files (~8MB)
   - **Note:** Popup demos (`popup/`) are included for local testing

3. **Identity Build** (`build-swarm-id.js`)
   - Builds SvelteKit app to `swarm-ui/build/`
   - Copies SvelteKit build to `swarm-id-build/`
   - Copies `lib/dist/` → `swarm-id-build/lib/`
   - Processes `demo/proxy.html` and `demo/auth.html`:
     - Injects environment config only
     - No inline bundling
   - Outputs to `swarm-id-build/demo/`

### Key Architectural Decision

**Library Distribution:**
- Library files are served as separate ES6 modules from `/lib/` path
- HTML files import via standard module syntax: `import { initProxy } from '/lib/swarm-id-proxy.js'`
- This provides better debugging, proper source maps, and follows web standards
- Previous inline bundling approach was removed due to complexity and special character issues

### Cross-Origin Communication

**Demo App** (swarm-demo.snaha.net):
- Embeds hidden iframe from `swarm-id.snaha.net/demo/proxy.html`
- Opens auth popup to `swarm-id.snaha.net/connect` (SvelteKit route)
- Uses postMessage for cross-origin communication
- Imports library from `/lib/swarm-id-client.js`

**Identity App** (swarm-id.snaha.net):
- Serves proxy iframe (`/demo/proxy.html`) that handles Bee API calls
- Serves auth pages for popup authentication
- Stores secrets in first-party localStorage (partitioned by browser)
- Library files accessible at `/lib/` path

### Security

- **CORS:** Both apps whitelist each other's origins
- **CSP:** Identity app allows iframe embedding from demo app
- **Storage Partitioning:** Browser enforces isolation per `(iframe-origin, parent-origin)` pair
- **Library Distribution:** Library files served as standard ES6 modules (publicly accessible but open source)

## Local Development

### Setup

1. Install mkcert: `brew install mkcert` (macOS)
2. Generate certificates:
   ```bash
   mkcert swarm-app.local swarm-id.local
   ```
3. Configure `/etc/hosts`:
   ```
   127.0.0.1  swarm-app.local
   127.0.0.1  swarm-id.local
   ```

### Run Servers

```bash
# Start both HTTPS servers (uses local domains)
./start-servers.sh

# Development mode with hot reload
./start-servers-dev.sh
```

Access demos:
- Library demo: `https://swarm-app.local:8080/demo/demo.html`
- Popup demo: `https://swarm-app.local:8080/popup/demo.html` (local only)
- Identity UI: `https://swarm-id.local:8081/`

## Troubleshooting

### Build Fails

**Issue:** Module not found errors
**Fix:** Run `pnpm install` at root to install all workspace dependencies

**Issue:** Library not built
**Fix:** Run `pnpm build:lib` before building apps

### CORS Errors in Production

**Issue:** postMessage blocked or CORS errors
**Fix:** Check that domain environment variables match deployed domains

### Iframe Not Loading

**Issue:** CSP or X-Frame-Options blocking iframe
**Fix:** Verify `.do-app-id.yaml` headers allow frame-ancestors from demo domain

## Next Steps

1. **Update branch:** Change deploy branch from `feat/create-swarm-ui` to `main` in `.do-app-*.yaml`
2. **Configure domains:** Set up custom domains in Digital Ocean dashboard
3. **SSL:** Digital Ocean automatically provisions SSL certificates
4. **Monitor:** Check build logs in Digital Ocean dashboard

## Related Documentation

- `README.md` - Project overview and architecture
- `CLAUDE.md` - Development guidelines for AI assistants
- `lib/README.md` - Library API reference
- `demo/README.md` - Demo implementation details
- `swarm-ui/CLAUDE.md` - SvelteKit UI development guide
