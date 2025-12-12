# Swarm Identity Management

This monorepo implements a cross-browser compatible authentication and identity management system for Swarm dApps.

## Packages

- **[lib/](./lib/README.md)** - The Swarm ID TypeScript library for authentication and Bee API operations
- **[swarm-ui/](./swarm-ui/)** - SvelteKit-based identity management UI
- **[demo/](./demo/)** - Demo dApp with library integration examples
- **[bee-js/](https://github.com/agazso/bee-js/tree/feat/encrypted-chunk-streams)** - A custom fork of the [bee-js](https://github.com/ethersphere/bee-js) library, containing encrypted, streaming chunked upload and download functionality.

## Architecture

The project uses an OAuth-style popup authentication flow that works across all browsers (Chrome, Firefox, Safari) without requiring the Storage Access API.

**Key Innovation**: The popup-based authentication allows dApps to securely derive app-specific secrets from a master identity, with browser-enforced storage partitioning providing cross-app isolation.

## Live Demos

The applications are deployed and available at:

- **Demo App**: [https://swarm-demo.snaha.net](https://swarm-demo.snaha.net)
- **Identity UI**: [https://swarm-id.snaha.net](https://swarm-id.snaha.net)

### Deployment

Both apps are deployed to Digital Ocean App Platform as separate static sites:

**swarm-demo.snaha.net** (`demo/build/`)
- Simple HTML demos with SwarmIdClient library
- Library files served from `/lib/` directory
- Standard ES6 module imports

**swarm-id.snaha.net** (`swarm-id-build/`)
- SvelteKit identity management UI
- Proxy/auth pages for iframe communication
- Library files served from `/lib/` directory

See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for detailed deployment configuration.

## Quick Start

### Build Everything

```bash
# Clone the forked bee-js library
git clone https://github.com/agazso/bee-js

# Build the forked bee-js library
cd bee-js && git checkout feat/encrypted-chunk-streams && npm install && npm build

# Install all workspace dependencies
pnpm install

# Build library + both apps
pnpm build

# Or build specific apps
pnpm build:swarm-demo    # Builds lib + demo app
pnpm build:swarm-id      # Builds lib + identity UI
```

### Build Outputs

**demo/build/** (Demo App)
```
demo/build/
├── index.html          # Demo app (renamed from demo.html during build)
└── lib/                # Library files (~8MB with source maps)
    ├── swarm-id-client.js
    ├── swarm-id-proxy.js
    ├── swarm-id-auth.js
    └── ... (types, maps, etc.)
```

**swarm-id-build/** (Identity UI)
```
swarm-id-build/
├── [SvelteKit app files including prerendered routes: /proxy, /connect]
└── lib/                # Library files (~8MB with source maps)
```

**Note:** Library files use standard ES6 module imports, not inline bundling.

See [lib/README.md](./lib/README.md) for detailed library documentation.

## Local Development Setup

### Prerequisites

1. **Install mkcert** (for local HTTPS certificates)

   On Linux:
   ```bash
   wget https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-amd64
   chmod +x mkcert-v1.4.4-linux-amd64
   sudo mv mkcert-v1.4.4-linux-amd64 /usr/local/bin/mkcert
   ```

   On macOS:
   ```bash
   brew install mkcert
   ```

2. **Generate SSL certificates**

   ```bash
   # Install the local CA
   mkcert -install

   # Generate certificates for local domains
   mkcert swarm-app.local swarm-id.local
   ```

   This will create:
   - `swarm-app.local+1.pem` (certificate)
   - `swarm-app.local+1-key.pem` (private key)

3. **Configure /etc/hosts**

   Add the following entries to `/etc/hosts`:
   ```
   127.0.0.1  swarm-app.local
   127.0.0.1  swarm-id.local
   ```

   Quick command (Linux/macOS):
   ```bash
   sudo bash -c 'echo "" >> /etc/hosts && echo "# Swarm local development domains" >> /etc/hosts && echo "127.0.0.1  swarm-app.local" >> /etc/hosts && echo "127.0.0.1  swarm-id.local" >> /etc/hosts'
   ```

### Starting the Development Servers

The project includes two Node.js HTTPS servers that serve content on different domains to simulate production cross-origin behavior.

#### Quick Start (no build required!)

```bash
# 1. Install and build library
pnpm install
cd lib && pnpm build

# 2. Start both HTTPS servers
./start-servers.sh
```

This starts:
- **server-app.js** on `https://swarm-app.local:8080` - serves demo files
- **server-id.js** on `https://swarm-id.local:8081` - serves identity UI

**Library serving:** Both servers map `/lib/*` → `lib/dist/*` automatically, so no build step needed for local development!

**Optional:** Build SvelteKit UI for full experience:
```bash
cd swarm-ui && pnpm build
```

#### Development Mode (with hot reload)

For SvelteKit development with hot module replacement:

```bash
# Terminal 1: Build library in watch mode (optional)
cd lib
pnpm build:watch

# Terminal 2: Start SvelteKit dev server
cd swarm-ui
pnpm dev

# Terminal 3: Start HTTPS proxy servers
./start-servers-dev.sh
```

The dev mode setup:
- **server-app.js** serves demo files from `demo/` (not build)
- **server-id.js** proxies to SvelteKit dev server (`localhost:5173`)
- Library changes require rebuild (use `pnpm build:watch`)
- HTML/CSS changes are served directly from disk

**Custom proxy target:**
```bash
PROXY_TARGET=http://localhost:3000 ./start-servers-dev.sh
```

**Important:**
- Demo HTML files import from `/lib/` which automatically maps to `lib/dist/`
- If you change library code, rebuild it: `cd lib && pnpm build`
- Use `cd lib && pnpm build:watch` for automatic rebuilds during development

#### Server Details

**server-app.js** (`https://swarm-app.local:8080`)
- Serves the demo dApp pages
- Default page: `demo-iframe-storage.html`
- Includes CORS headers for cross-origin requests
- Supports all common file types (HTML, JS, CSS, JSON, images)

**server-id.js** (`https://swarm-id.local:8081`)
- **Production mode**: Serves built SvelteKit app from `swarm-ui/build/`
- **Dev mode** (`PROXY_TARGET` set): Proxies to dev server (e.g., `localhost:5173`)
- Always serves `/demo/` and `/lib/` files from disk
- Includes Service Worker support with proper headers
- CORS configured for `swarm-app.local`

Both servers:
- Use HTTPS with mkcert-generated certificates
- Log all requests with timestamps
- Automatically handle MIME types
- Listen on `127.0.0.1` (localhost only)

### Testing the Setup

1. **Quick start** (just library):
   ```bash
   cd lib && pnpm build   # Build library once
   ./start-servers.sh     # Start servers
   ```

2. **Full experience** (with SvelteKit UI):
   ```bash
   pnpm build            # Build everything
   ./start-servers.sh    # Start servers
   ```

3. Open demos in your browser:
   - **Demo App**: `https://swarm-app.local:8080/` (serves demo/demo.html)
   - **Identity UI**: `https://swarm-id.local:8081/`

4. **Accept browser security warnings**
   - Self-signed certificates trigger warnings
   - This is safe for local development
   - Click "Advanced" → "Accept Risk and Continue"
   - Accept warnings for BOTH domains (swarm-app.local and swarm-id.local)

5. Test the authentication flow:
   - Click "Login with Swarm ID"
   - Popup opens on `swarm-id.local`
   - Complete authentication
   - Popup closes and you're authenticated
   - Try uploading/downloading data

## Project Structure

```
.
├── lib/                  # Swarm ID TypeScript library
│   ├── src/              # Library source code
│   ├── dist/             # Built library files (ES6 modules)
│   └── README.md         # Library documentation
├── demo/                 # Demo app package
│   ├── demo.html         # Library demo HTML
│   ├── build.js          # Build script (copies lib, injects config)
│   └── build/            # Build output (deployed to swarm-demo.snaha.net)
│       ├── index.html    # Demo app (renamed from demo.html)
│       └── lib/          # Library files (~8MB)
├── swarm-ui/             # SvelteKit identity management UI
│   ├── src/              # SvelteKit source code
│   │   └── routes/       # SvelteKit routes including /proxy and /connect
│   └── build/            # SvelteKit production build
├── bee-js/               # bee-js library (linked dependency)
├── swarm-id-build/       # Build output (deployed to swarm-id.snaha.net)
│   ├── [SvelteKit app]   # SvelteKit production files (includes /proxy and /connect routes)
│   └── lib/              # Library files (~8MB)
├── server-app.js         # Local HTTPS server for swarm-app.local:8080
├── server-id.js          # Local HTTPS server for swarm-id.local:8081
├── start-servers.sh      # Start both servers (production mode)
├── start-servers-dev.sh  # Start both servers (dev mode with proxy)
└── swarm-app.local+1*.pem  # SSL certificates (mkcert)
```

### Key Build Artifacts

**Library Distribution** (`lib/dist/`)
- ES6 modules with TypeScript definitions
- Source maps for debugging
- ~350KB per module (uncompressed)
- Imported via standard `<script type="module">`

**Demo App Build** (`demo/build/`)
- Copies library files to `lib/`
- Injects environment config into HTML
- No inline bundling - uses module imports
- Deployed to swarm-demo.snaha.net

**Identity UI Build** (`swarm-id-build/`)
- Full SvelteKit production build
- Copies library files to `lib/`
- Proxy/auth HTML pages in `demo/`
- Deployed to swarm-id.snaha.net

## Documentation

- **[The Book of Swarm](./The-Book-of-Swarm.pdf)**: Comprehensive Swarm documentation
- **[Swarm Identity Management Proposal](./docs/Swarm-Identity-Management-Proposal.md)**: Identity system proposal
- **[Library Documentation](./lib/README.md)**: API reference and usage examples

## Development Workflow

### Quick Start

```bash
# 1. One-time setup
mkcert -install
mkcert swarm-app.local swarm-id.local
sudo bash -c 'echo "127.0.0.1 swarm-app.local swarm-id.local" >> /etc/hosts'

# 2. Install and build
pnpm install
cd lib && pnpm build   # Build library
cd ..

# 3. Start servers
./start-servers.sh

# 4. Open browser
# Visit: https://swarm-app.local:8080/demo.html
# Accept security warnings for both domains
```

**With SvelteKit development:**
```bash
# Terminal 1: SvelteKit dev server with hot reload
cd swarm-ui && pnpm dev

# Terminal 2: HTTPS proxy servers
./start-servers-dev.sh
```

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser: https://swarm-app.local:8080                  │
│  ┌────────────────────────────────────────────────┐     │
│  │ Demo HTML (server-app.js)                      │     │
│  │                                                 │     │
│  │  ┌─────────────────────────────────────────┐   │     │
│  │  │ <iframe src="https://swarm-id.local">   │   │     │
│  │  │                                          │   │     │
│  │  │ swarm-id.local:8081 (server-id.js)      │   │     │
│  │  │   ↓ proxies to ↓                        │   │     │
│  │  │ localhost:5173 (pnpm dev)               │   │     │
│  │  │   - Hot reload enabled                  │   │     │
│  │  │   - SvelteKit UI                        │   │     │
│  │  └─────────────────────────────────────────┘   │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

## Development Tips

- **TypeScript Execution**: Use `pnpx tsx` instead of `npx ts-node` to run TypeScript files
- **Browser DevTools**: Check Application → Storage to verify storage partitioning
- **CORS Issues**: Make sure you're accessing via the correct domain (not `localhost`)
- **Certificate Issues**: Regenerate certificates with `mkcert` if browsers reject them
- **Hot Reload**: Changes in `swarm-ui/src/` will automatically reload in the browser
- **Debugging**: Use browser DevTools on both the parent page and the iframe

## Troubleshooting

### Servers won't start
- Check if ports 8080 and 8081 are already in use: `lsof -i :8080 -i :8081`
- Ensure certificate files exist and are readable

### Cannot access swarm-app.local
- Verify `/etc/hosts` configuration: `grep swarm /etc/hosts`
- Clear browser DNS cache or restart browser
- Try ping: `ping swarm-app.local`

### Browser rejects certificates
- Reinstall mkcert CA: `mkcert -install`
- Regenerate certificates: `mkcert swarm-app.local swarm-id.local`
- Check certificate files exist in project root

### Authentication popup blocked
- Allow popups for `swarm-app.local` in browser settings
- Ensure popup is triggered by user action (not programmatically)

### Dev mode shows "502 Bad Gateway"
- Make sure `pnpm dev` is running in `swarm-ui/`
- Verify the dev server is running on the correct port (default: 5173)
- Check `PROXY_TARGET` environment variable if using custom port
- Restart both the dev server and proxy servers

## License

[Apache 2.0](LICENSE)
