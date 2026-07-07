# Swarm Identity Management

Cross-browser compatible authentication and identity management for Swarm dApps.

**[Documentation](https://swarm.snaha.net/docs)** | **[Identity UI](https://swarm-id.snaha.net)** | **[Demo](https://swarm-demo.snaha.net)** | **[Legacy Identity UI](https://swarm.snaha.net/id-legacy/)**

## Packages

- **[lib/](./lib/README.md)** — `@snaha/swarm-id` TypeScript library for authentication and Bee API operations
- **[ui/](./ui/README.md)** — `@swarm-id/ui` next-generation identity UI (standalone product, active redesign)
- **[swarm-ui/](./swarm-ui/)** — legacy SvelteKit identity management UI (trusted domain), being superseded by `ui/`
- **[demo/](./demo/)** — Demo dApp with library integration examples
- **[docs-site/](./docs-site/)** — Starlight (Astro) documentation website

## Architecture

The project uses an OAuth-style popup authentication flow using the Storage Access API. Chrome and Firefox work out of the box; Safari works in download-only mode (auth works, uploads disabled due to ITP storage partitioning).

**Key Innovation**: The popup-based authentication allows dApps to securely derive app-specific secrets from a master identity, with browser-enforced storage partitioning providing cross-app isolation.

[Architecture deep-dive →](https://swarm.snaha.net/docs/architecture)

## Quick Start

```bash
pnpm add @snaha/swarm-id
```

```typescript
import { SwarmIdClient } from '@snaha/swarm-id'

const client = new SwarmIdClient({
  iframeOrigin: 'https://swarm-id.snaha.net',
  metadata: {
    name: 'My dApp',
    description: 'A demo Swarm application',
  },
  onConnectionChange: (info) => {
    console.log('Connection changed:', info.identity?.name, 'canUpload=', info.canUpload)
  },
})

await client.initialize()

// A connected user can still have canUpload=false (no postage stamp and no
// subsidised gateway), so gate uploads on both.
const info = client.connectionInfo
if (info.identity && info.canUpload) {
  const result = await client.uploadData(new TextEncoder().encode('Hello, Swarm!'))
  console.log('Uploaded:', result.reference)
}

client.destroy()
```

[Full integration guide →](https://swarm.snaha.net/docs/getting-started)

## Deployment

### GitHub Pages — `swarm.snaha.net`

The latest `main` build of every app deploys to root paths, and every PR gets previews under
`…/pr-N/` (workflows: `deploy-main-pages.yml`, `deploy-preview.yml`):

| Path                           | App                                 |
| ------------------------------ | ----------------------------------- |
| `swarm.snaha.net/id/`          | new identity UI (`ui/`)             |
| `swarm.snaha.net/id-legacy/`   | legacy identity UI (`swarm-ui/`)    |
| `swarm.snaha.net/demo/`        | demo, running against the new `/id` |
| `swarm.snaha.net/demo-legacy/` | demo, running against `/id-legacy`  |
| `swarm.snaha.net/docs/`        | documentation site                  |

### DigitalOcean App Platform (canonical domains)

Deployed on every push to `main` (workflow: `deploy-do.yml`):

**swarm-id.snaha.net** (`ui/build/`)

- New SvelteKit identity UI (`ui/`)
- Proxy/connect pages for iframe communication

**swarm-demo.snaha.net** (`demo/build/`)

- SvelteKit demo app showcasing SwarmIdClient integration, run against swarm-id.snaha.net
- Built with `@sveltejs/adapter-static`

## Local Development

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000 - that's it!

- Demo app runs on port 3000
- Identity UI runs on port 5510
- No HTTPS, certificates, or custom domains required (`localhost` is a secure context)

**Note:** Safari operates in download-only mode — authentication and downloads work, but uploads are disabled due to ITP storage partitioning. See [#167](https://github.com/snaha/swarm-id/issues/167) for details.

### Development Mode (with hot reload)

```bash
# Start the full stack against the new identity UI (ui :5500 + demo :3500)
pnpm dev:new

# Start the full stack against the legacy identity UI (swarm-ui :5510 + demo :3000)
pnpm dev:legacy      # `pnpm dev` is an alias

# Or start individually
pnpm dev:ui:new      # New identity UI on port 5500
pnpm dev:ui:legacy   # Legacy identity UI on port 5510
pnpm dev:demo:new    # Demo on port 3500, connected to the new identity UI (:5500)
pnpm dev:demo:legacy # Demo on port 3000, connected to the legacy identity UI (:5510)
pnpm dev:demo        # Demo on port 3000, identity UI origin from demo/.env (legacy)
pnpm dev:lib         # Library watch mode (rebuilds on changes)
```

### Local Bee Cluster (bee-compose)

For local development with postage stamps and uploads, use [@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose) to run a local Bee cluster with blockchain. Requires Docker.

```bash
# Start cluster (queen + 1 light worker)
pnpm dev:bee:detach

# View logs
pnpm dev:bee:logs

# Stop cluster
pnpm dev:bee:stop

# Fresh start (pull latest images, purge data)
pnpm dev:bee:fresh
```

**Endpoints:**

| Service        | URL                      |
| -------------- | ------------------------ |
| Queen Bee API  | `http://localhost:1633`  |
| Worker 1 API   | `http://localhost:16331` |
| Blockchain RPC | `http://localhost:9545`  |

**Buying a Postage Stamp:**

The easiest way is to use the Developer Tools page in the Identity UI:

1. Navigate to http://localhost:5510/dev
2. Go to the **Stamps** tab
3. Click **Buy Stamp** with the default settings

Or use the Bee API directly:

```bash
# Buy stamp (amount=500000000, depth=20)
# The amount must exceed ~414720000 — the local chain's price (24000)
# times Bee's 17280-block (~24h) minimum validity.
curl -X POST "http://localhost:1633/stamps/500000000/20"

# Wait ~30 seconds, then verify it's usable:
curl "http://localhost:1633/stamps/<batchID>"
```

See the [Local Development guide](https://swarm.snaha.net/docs/local-development) for client-side stamp signing, known dev keys, SSH tunnel setup, and more.

### Developer Tools (/dev route)

The Identity UI includes a Developer Tools page at http://localhost:5510/dev with utilities for local development:

- **Overview**: Quick start guide and local Bee endpoint links with copy buttons
- **Stamps**: Buy postage stamps from the local Bee node using pre-funded signer keys
- **Sync**: Manually trigger account sync to test postage stamp utilization tracking

## Project Structure

```
.
├── lib/                  # @snaha/swarm-id TypeScript library
├── ui/                   # New identity UI (SvelteKit + Tailwind v4 + shadcn-svelte style)
├── demo/                 # Demo app (SvelteKit)
├── swarm-ui/             # Legacy identity management UI (SvelteKit)
└── docs-site/            # Documentation website (Starlight/Astro)
```

## Troubleshooting

### Demo not loading

- Check if ports 3000 and 5510 are already in use: `lsof -i :3000 -i :5510`
- Ensure both servers are running: `pnpm dev`

### Authentication popup blocked

- Allow popups for localhost in browser settings
- Ensure popup is triggered by user action (not programmatically)

### Changes not reflecting

- Library changes: restart `pnpm dev:lib` or rebuild
- SvelteKit changes: automatic hot reload

### Safari limitations

Safari's Intelligent Tracking Prevention (ITP) partitions storage for third-party iframes, which prevents access to signing keys and postage stamps. Safari operates in **download-only mode**: authentication and downloads work, but uploads are not available.

- **Safari private mode**: Sessions are ephemeral (lost when the private window closes)

See [#167](https://github.com/snaha/swarm-id/issues/167) for details.

## Contribute

We have a separate [guide document](CONTRIBUTING.md) if you want to contribute to the project.

## License

[Apache 2.0](LICENSE)
