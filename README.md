# Swarm Identity Management

This monorepo implements a cross-browser compatible authentication and identity management system for Swarm dApps.

## Packages

- **[lib/](./lib/README.md)** - The Swarm ID TypeScript library for authentication and Bee API operations
- **[swarm-ui/](./swarm-ui/)** - SvelteKit-based identity management UI
- **popup/** - Demo implementation with OAuth-style popup authentication

## Architecture

The project uses an OAuth-style popup authentication flow that works across all browsers (Chrome, Firefox, Safari) without requiring the Storage Access API. See the [popup folder](./popup) for detailed documentation.

**Quick Overview**: The popup-based authentication allows dApps to securely derive app-specific secrets from a master identity, with browser-enforced storage partitioning providing cross-app isolation.

## Library Quick Start

```bash
# Install dependencies
pnpm install

# Build the library
pnpm build

# Watch mode for development
pnpm build:watch

# Lint code
pnpm lint
```

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

The project includes two Node.js HTTPS servers that serve content on different domains:

#### Production Mode (serve built files)

```bash
# Build the SvelteKit UI first
cd swarm-ui
pnpm install
pnpm build
cd ..

# Start both servers
./start-servers.sh
```

This convenience script:
- Checks if `/etc/hosts` is properly configured
- Starts both servers in the background
- Serves the built SvelteKit app from `swarm-ui/build/`
- Provides clear status messages
- Handles graceful shutdown on Ctrl+C

#### Development Mode (with hot reload)

For SvelteKit development with hot module replacement:

```bash
# Terminal 1: Start the SvelteKit dev server
cd swarm-ui
pnpm install
pnpm dev

# Terminal 2: Start the HTTPS proxy servers
./start-servers-dev.sh
```

The dev mode script:
- Starts `server-app.js` on port 8080 (serves demo HTML)
- Starts `server-id.js` on port 8081 (proxies to `localhost:5173`)
- Enables hot reload for the SvelteKit UI
- `/demo/` and `/popup/` files are served from disk

**Custom proxy target:**
```bash
PROXY_TARGET=http://localhost:3000 ./start-servers-dev.sh
```

#### Server Details

**server-app.js** (`https://swarm-app.local:8080`)
- Serves the demo dApp pages
- Default page: `demo-iframe-storage.html`
- Includes CORS headers for cross-origin requests
- Supports all common file types (HTML, JS, CSS, JSON, images)

**server-id.js** (`https://swarm-id.local:8081`)
- **Production mode**: Serves built SvelteKit app from `swarm-ui/build/`
- **Dev mode** (`PROXY_TARGET` set): Proxies to dev server (e.g., `localhost:5173`)
- Always serves `/demo/` and `/popup/` files from disk
- Includes Service Worker support with proper headers
- CORS configured for `swarm-app.local`

Both servers:
- Use HTTPS with mkcert-generated certificates
- Log all requests with timestamps
- Automatically handle MIME types
- Listen on `127.0.0.1` (localhost only)

### Testing the Setup

1. Start the servers:
   ```bash
   ./start-servers.sh
   ```

2. Open the demo in your browser:
   ```
   https://swarm-app.local:8080/popup/demo.html
   ```

3. **Important**: Accept the browser security warnings
   - The warnings appear because we're using self-signed certificates
   - This is safe for local development
   - Click "Advanced" → "Accept Risk and Continue" (or equivalent)
   - You may need to accept warnings for both domains

4. Test the authentication flow:
   - Click "Login with Swarm ID"
   - A popup opens on `swarm-id.local`
   - Complete authentication
   - The popup closes and you're authenticated

## Project Structure

```
.
├── swarm-ui/              # SvelteKit identity management UI
│   ├── src/              # SvelteKit source code
│   ├── build/            # Production build output
│   └── README.md         # SvelteKit documentation
├── popup/                # OAuth-style popup authentication system
│   ├── auth.html         # Authentication popup UI (legacy)
│   ├── proxy.html        # Hidden iframe proxy for API calls
│   ├── demo.html         # Demo dApp page
│   └── README.md         # Detailed documentation
├── lib/                  # Swarm ID TypeScript library
├── bee/                  # Bee project source code
├── bee-js/               # bee-js project source code
├── swarm-cli/           # Swarm CLI tools
├── server-app.js        # HTTPS server for swarm-app.local:8080
├── server-id.js         # HTTPS server for swarm-id.local:8081 (with proxy support)
├── start-servers.sh     # Start servers in production mode
├── start-servers-dev.sh # Start servers in dev mode (with proxy)
├── swarm-app.local+1.pem           # SSL certificate (mkcert)
└── swarm-app.local+1-key.pem       # SSL private key (mkcert)
```

## Documentation

- **[The Book of Swarm](./The-Book-of-Swarm.pdf)**: Comprehensive Swarm documentation
- **[Swarm Identity Management Proposal](./Swarm%20Identity%20Management%20Proposal.rtf)**: Identity system proposal
- **[Popup Authentication](./popup/README.md)**: Detailed technical documentation for the popup-based auth system

## Development Workflow

### Quick Start (Development Mode)

```bash
# 1. One-time setup
mkcert -install
mkcert swarm-app.local swarm-id.local
sudo bash -c 'echo "127.0.0.1 swarm-app.local swarm-id.local" >> /etc/hosts'

# 2. Install dependencies
cd swarm-ui
pnpm install
cd ..

# 3. Terminal 1: Start SvelteKit dev server
cd swarm-ui
pnpm dev

# 4. Terminal 2: Start HTTPS proxy servers
./start-servers-dev.sh

# 5. Open browser
# Visit: https://swarm-app.local:8080/demo-iframe-storage.html
# Accept security warnings for both domains
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

MIT
