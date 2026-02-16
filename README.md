# Swarm Identity Management

This monorepo implements a cross-browser compatible authentication and identity management system for Swarm dApps.

## Packages

- **[lib/](./lib/README.md)** - The Swarm ID TypeScript library for authentication and Bee API operations
- **[swarm-ui/](./swarm-ui/)** - SvelteKit-based identity management UI
- **[demo/](./demo/)** - Demo dApp with library integration examples
- **[docs-site/](./docs-site/)** - Starlight (Astro) documentation website
- **[bee-js/](https://github.com/agazso/bee-js/tree/feat/encrypted-chunk-streams)** - A custom fork of the [bee-js](https://github.com/ethersphere/bee-js) library, containing encrypted, streaming chunked upload and download functionality.

## Architecture

The project uses an OAuth-style popup authentication flow that works across all browsers (Chrome, Firefox, Safari) using the Storage Access API.

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
├── index.html          # Demo app
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

### Quick Start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000 - that's it!

- Demo app runs on port 3000
- Identity UI runs on port 5174
- No HTTPS, certificates, or custom domains required (`localhost` is a secure context)

**Note:** Safari is not supported for local development due to strict storage partitioning.

### Development Mode (with hot reload)

```bash
# Start both demo and identity UI
pnpm dev

# Or start individually
pnpm dev:swarm-ui    # Identity UI on port 5174
pnpm dev:demo        # Demo on port 3000
pnpm dev:lib         # Library watch mode (rebuilds on changes)
```

### Local Bee Cluster (FDP Play)

For local development with postage stamps and uploads, use FDP Play to run a local Bee cluster with blockchain. Requires Docker.

```bash
# Start cluster (queen + 1 worker node)
pnpm dev:bee:detach

# View logs
pnpm dev:bee:logs

# Stop cluster
pnpm dev:bee:stop

# Fresh start (pull latest images, purge data)
pnpm dev:bee:fresh
```

**Endpoints:**

| Service | URL |
|---------|-----|
| Queen Bee API | `http://localhost:1633` |
| Worker 1 API | `http://localhost:11633` |
| Blockchain RPC | `http://localhost:9545` |

**Buying a Postage Stamp:**

The easiest way is to use the Developer Tools page in the Identity UI:

1. Navigate to http://localhost:5174/dev
2. Go to the **Stamps** tab
3. Click **Buy Stamp** with the default settings

Or use the Bee API directly:

```bash
# Buy stamp (amount=10000000, depth=17)
curl -X POST "http://localhost:1633/stamps/10000000/17"

# Wait ~30 seconds, then verify it's usable:
curl "http://localhost:1633/stamps/<batchID>"
```

**Client-Side Stamp Signing:**

Stamps bought via the API are owned by the queen node. Use the queen's private key for client-side signing:

```typescript
import { Stamper } from '@ethersphere/bee-js'

const queenKey = '566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9'
const stamper = Stamper.fromBlank(queenKey, batchId, depth)
const envelope = stamper.stamp(chunk)
```

**Known Keys:**

| Node | Private Key | Address |
|------|-------------|---------|
| Queen | `566058308ad5fa3888173c741a1fb902c9f1f19559b11fc2738dfc53637ce4e9` | `0x26234a2ad3ba8b398a762f279b792cfacd536a3f` |
| Worker 1 | `195cf6324303f6941ad119d0a1d2e862d810078e1370b8d205552a543ff40aab` | - |

### Developer Tools (/dev route)

The Identity UI includes a Developer Tools page at http://localhost:5174/dev with utilities for local development:

- **Overview**: Quick start guide and local Bee endpoint links with copy buttons
- **Stamps**: Buy postage stamps from the local Bee node using pre-funded signer keys
- **Sync**: Manually trigger account sync to test postage stamp utilization tracking

### Testing with Real Domains (SSH Tunnel)

To test storage partitioning behavior with real TLS certificates (as in production), you can use SSH tunnels to a VPS with nginx.

**Architecture:**
```
Your VPS (nginx + HTTPS)              Your Local Machine
┌─────────────────────────┐           ┌─────────────────────┐
│ demo.yourdomain.com     │◄──────────│ SSH -R tunnels      │
│   → 127.0.0.1:18080     │           │   18080 → demo      │
│ id.yourdomain.com       │           │   5174 → identity   │
│   → 127.0.0.1:5174      │           │   (Vite dev server) │
└─────────────────────────┘           └─────────────────────┘
```

**VPS Setup (one-time):**
1. Add nginx server blocks pointing to `127.0.0.1:18080` (demo) and `127.0.0.1:5174` (identity)
2. Get SSL certificates with certbot
3. Add DNS A records for both subdomains

**Local usage:**
```bash
# Terminal 1: Start demo server
pnpm dev:demo

# Terminal 2: Start SvelteKit dev server with allowed hosts
VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=id.yourdomain.com pnpm dev:swarm-ui

# Terminal 3: Open SSH tunnel
ssh -R 18080:localhost:3000 -R 5174:localhost:5174 user@your-vps
```

**Note:** The `VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` environment variable is required when accessing the Vite dev server through a foreign hostname. Without it, Vite will reject requests from the tunneled domain.

**Access the demo:**
```
https://demo.yourdomain.com/?idDomain=https://id.yourdomain.com
```

The `?idDomain=` parameter tells the demo which identity service to use. This allows testing cross-origin storage partitioning with real browser security policies while still having hot reload for the identity UI.

**Important:**
- Demo HTML files import from `/lib/` which automatically maps to `lib/dist/`
- If you change library code, rebuild it: `cd lib && pnpm build`
- Use `cd lib && pnpm build:watch` for automatic rebuilds during development

## Project Structure

```
.
├── lib/                  # Swarm ID TypeScript library
│   ├── src/              # Library source code
│   ├── dist/             # Built library files (ES6 modules)
│   └── README.md         # Library documentation
├── demo/                 # Demo app package
│   ├── index.html        # Library demo HTML
│   ├── build.js          # Build script (copies lib, injects config)
│   └── build/            # Build output (deployed to swarm-demo.snaha.net)
├── swarm-ui/             # SvelteKit identity management UI
│   ├── src/              # SvelteKit source code
│   │   └── routes/       # SvelteKit routes including /proxy and /connect
│   └── build/            # SvelteKit production build
├── docs-site/            # Starlight documentation site
│   ├── src/content/docs/ # Documentation pages (MDX)
│   └── dist/             # Built static site
├── bee-js/               # bee-js library (linked dependency)
└── swarm-id-build/       # Build output (deployed to swarm-id.snaha.net)
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

- **[Documentation Site](./docs-site/)**: Full documentation website (run `pnpm docs:dev` to preview)
- **[The Book of Swarm](./The-Book-of-Swarm.pdf)**: Comprehensive Swarm documentation
- **[Swarm Identity Management Proposal](./docs/Swarm-Identity-Management-Proposal.md)**: Identity system proposal
- **[Library Documentation](./lib/README.md)**: API reference and usage examples

### Documentation Development

```bash
# Start docs dev server (http://localhost:4321)
pnpm dev:docs

# Build docs for production
pnpm build:docs

# Preview production build
pnpm preview:docs
```

## Development Workflow

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser: http://localhost:3000 (Demo App)              │
│  ┌────────────────────────────────────────────────┐     │
│  │ Demo HTML                                      │     │
│  │                                                │     │
│  │  ┌─────────────────────────────────────────┐   │     │
│  │  │ <iframe src="http://localhost:5174">    │   │     │
│  │  │                                         │   │     │
│  │  │ Identity UI (SvelteKit)                 │   │     │
│  │  │   - Proxy for Bee API calls             │   │     │
│  │  │   - Auth popup handler                  │   │     │
│  │  └─────────────────────────────────────────┘   │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

## Development Tips

- **TypeScript Execution**: Use `pnpx tsx` instead of `npx ts-node` to run TypeScript files
- **Browser DevTools**: Check Application → Storage to verify storage partitioning
- **Hot Reload**: Changes in `swarm-ui/src/` will automatically reload in the browser
- **Debugging**: Use browser DevTools on both the parent page and the iframe

## AI Coding Agent Configuration

This project includes configuration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and other AI coding agents, following [best practices](https://code.claude.com/docs/en/best-practices.md) for effective AI-assisted development.

### Structure

```
CLAUDE.md                        → symlink to AGENT.md
AGENT.md                         # Core project context: architecture, commands, code style rules
.claude/
├── settings.json                # Shared team settings (permissions, hooks)
├── settings.local.json          # Personal overrides (gitignored)
└── rules/                       # Modular, path-scoped instructions
    ├── swarm-ui.md              # Svelte 5, Diete, Carbon Icons (loads for swarm-ui/** only)
    ├── figma.md                 # Figma MCP workflow (loads for swarm-ui/** only)
    └── bee-cluster.md           # Local Bee cluster commands and known dev keys
```

### How It Works

- **`AGENT.md`** is the main instruction file, kept concise (~100 lines). It contains only information that would cause mistakes if absent: architecture overview, essential commands, code style rules (no-semicolons, no-null, no-any), and pre-commit requirements.

- **`.claude/rules/`** contains modular rules that load automatically based on which files are being edited. For example, Svelte 5 rune patterns and Diete design system conventions only load when working in `swarm-ui/`.

- **`.claude/settings.json`** defines shared team configuration:
  - **Permissions**: Pre-approved commands (`pnpm build`, `pnpm check:all`, `git status`, Figma MCP tools, etc.) so agents don't prompt for common operations.

- **`settings.local.json`** (gitignored) is for personal permission overrides.

### Adding New Rules

To add context that only applies to a specific package or directory, create a new `.md` file in `.claude/rules/` with a YAML frontmatter `paths` filter:

```markdown
---
paths:
  - "lib/**"
---

# lib-specific instructions here
```

## Troubleshooting

### Demo not loading
- Check if ports 3000 and 5174 are already in use: `lsof -i :3000 -i :5174`
- Ensure both servers are running: `pnpm dev`

### Authentication popup blocked
- Allow popups for localhost in browser settings
- Ensure popup is triggered by user action (not programmatically)

### Changes not reflecting
- Library changes: restart `pnpm dev:lib` or rebuild
- SvelteKit changes: automatic hot reload

### Safari not working
- Safari is not supported for local development due to strict storage partitioning
- Use Chrome or Firefox instead

## License

[Apache 2.0](LICENSE)
