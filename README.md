# Swarm Identity Management

Cross-browser compatible authentication and identity management system for Swarm dApps.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000

That's it! The demo runs on port 3000, identity UI on port 5174.

## Packages

- **[lib/](./lib/README.md)** - TypeScript library for authentication and Bee API operations
- **[swarm-ui/](./swarm-ui/)** - SvelteKit identity management UI
- **[demo/](./demo/)** - Demo dApp with library integration examples
- **[docs-site/](./docs-site/)** - Documentation website
- **[bee-js/](https://github.com/agazso/bee-js/tree/feat/encrypted-chunk-streams)** - Forked bee-js with encrypted streaming

## Architecture

The project uses an OAuth-style popup authentication flow that works across all browsers without requiring extensions.

```
┌─────────────────────────────────────────────────────────┐
│  Browser: http://localhost:3000 (Demo App)              │
│  ┌────────────────────────────────────────────────┐     │
│  │ Demo HTML                                       │     │
│  │                                                 │     │
│  │  ┌─────────────────────────────────────────┐   │     │
│  │  │ <iframe src="http://localhost:5174">    │   │     │
│  │  │                                          │   │     │
│  │  │ Identity UI (SvelteKit)                 │   │     │
│  │  │   - Proxy for Bee API calls             │   │     │
│  │  │   - Auth popup handler                  │   │     │
│  │  └─────────────────────────────────────────┘   │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

**Key Innovation**: Browser-enforced storage partitioning provides cross-app isolation. The Storage Access API or postMessage fallback ensures auth data flows correctly between popup and iframe.

## Live Demos

- **Demo App**: https://swarm-demo.snaha.net
- **Identity UI**: https://swarm-id.snaha.net

## Development

### Available Scripts

```bash
# Start development (demo + identity UI)
pnpm dev

# Start individual services
pnpm dev:swarm-ui    # Identity UI on port 5174
pnpm dev:demo        # Demo on port 3000
pnpm dev:lib         # Library in watch mode

# Build
pnpm build           # Build all packages
pnpm build:lib       # Build library only
pnpm build:swarm-id  # Build for production deployment

# Quality checks
pnpm check:all       # Run all checks (lint, typecheck, test)
```

### Development Workflow

1. **Start dev servers**: `pnpm dev`
2. **Open demo**: http://localhost:3000
3. **Make changes**:
   - SvelteKit changes hot-reload automatically
   - Library changes need rebuild: `pnpm dev:lib` (watch mode)

### Testing Authentication

1. Click "Connect" or "Login with Swarm ID"
2. Popup opens for authentication
3. Create account or sign in with passkey/SIWE
4. Return to demo - you're authenticated
5. Try uploading/downloading data

## Project Structure

```
.
├── lib/                  # TypeScript library
│   ├── src/              # Library source code
│   └── dist/             # Built library (ES6 modules)
├── demo/                 # Demo app
│   └── index.html        # Library demo
├── swarm-ui/             # SvelteKit identity UI
│   └── src/routes/       # Routes including /proxy and /connect
├── docs-site/            # Documentation site
└── bee-js/               # Forked bee-js (linked dependency)
```

## Documentation

- **[Library Documentation](./lib/README.md)** - API reference and usage examples
- **[Documentation Site](./docs-site/)** - Full docs (run `pnpm dev:docs`)

## Testing with Real Domains (SSH Tunnel)

For testing with real TLS certificates:

```bash
# Terminal 1: Start demo server
pnpm dev:demo

# Terminal 2: Start SvelteKit with allowed hosts
VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=id.yourdomain.com pnpm dev:swarm-ui

# Terminal 3: SSH tunnel to your VPS
ssh -R 18080:localhost:3000 -R 5174:localhost:5174 user@your-vps
```

Access via: `https://demo.yourdomain.com/?idDomain=https://id.yourdomain.com`

## Troubleshooting

### Demo not loading
- Ensure both servers are running: `pnpm dev`
- Check ports 3000 and 5174 are not in use

### Authentication popup blocked
- Allow popups for localhost in browser settings

### Changes not reflecting
- Library changes: restart `pnpm dev:lib`
- SvelteKit changes: automatic hot reload

### WebAuthn not working
- Ensure you're on `localhost` (secure context)
- Check browser supports WebAuthn

### Safari: Custom connect button not working
Safari partitions localStorage for iframes, so storage events don't work between the popup and proxy iframe during local development. **Use the iframe button instead** (set `containerId` in config). This limitation doesn't affect production deployments with real domains.

## License

[Apache 2.0](LICENSE)
