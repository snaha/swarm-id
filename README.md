# Swarm Identity Management

Cross-browser compatible authentication and identity management for Swarm dApps.

**[Documentation](https://swarm.snaha.net/docs)** | **[Identity UI](https://swarm-id.snaha.net)** | **[Demo](https://swarm-demo.snaha.net)**

## Packages

- **[lib/](./lib/README.md)** — `@snaha/swarm-id` TypeScript library for authentication and Bee API operations
- **[ui/](./ui/README.md)** — `@swarm-id/ui` SvelteKit identity UI (trusted domain)
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

| Path                    | App                         |
| ----------------------- | --------------------------- |
| `swarm.snaha.net/id/`   | identity UI (`ui/`)         |
| `swarm.snaha.net/demo/` | demo, running against `/id` |
| `swarm.snaha.net/docs/` | documentation site          |

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

Open http://localhost:3500 - that's it!

- Demo app runs on port 3500
- Identity UI runs on port 5500
- No HTTPS, certificates, or custom domains required (`localhost` is a secure context)

**Note:** Safari operates in download-only mode — authentication and downloads work, but uploads are disabled due to ITP storage partitioning. See [#167](https://github.com/snaha/swarm-id/issues/167) for details.

### Development Mode (with hot reload)

```bash
# Start the full stack (identity UI :5500 + demo :3500 against it)
pnpm dev

# Or start individually
pnpm dev:ui          # Identity UI on port 5500
pnpm dev:demo        # Demo on port 3500, connected to the identity UI (:5500)
pnpm dev:lib         # Library watch mode (rebuilds on changes)
```

### Local Bee Cluster (bee-compose)

For local development with postage stamps and uploads you need a Bee cluster and its chain.
Requires Docker.

```bash
pnpm dev:local        # cluster + both chains + solver + UI + demo
pnpm dev:local:fresh  # the same, from a clean chain and empty node state
pnpm dev:local:stop   # tear the containers down
pnpm dev:cluster:logs # tail the queen
```

The cluster comes from the `vendor/bee-compose` submodule, which carries the chain it boots — see
[Paying for storage locally](#paying-for-storage-locally). `pnpm dev:cluster start --full 4` runs
it alone, without the chains, solver or apps, which is what CI does for the library's integration
suite.

> Clone with `--recurse-submodules` (or run `git submodule update --init`) — the chain snapshot and
> the cluster live there. The submodule builds itself on first use, so there is nothing else to run.

**Endpoints:**

| Service        | URL                      |
| -------------- | ------------------------ |
| Queen Bee API  | `http://localhost:1633`  |
| Worker 1 API   | `http://localhost:16331` |
| Blockchain RPC | `http://localhost:9545`  |

**Getting a drive to work with:**

The easiest way is the Developer Tools page in the Identity UI:

1. Navigate to http://localhost:5500/dev
2. Go to the **Chain** tab
3. **Create owned batch**, then **Import batch** to attach it as a drive

That creates a real batch owned by the account's own postage signer, so it can be extended and
resized like a bought one. To buy a node-owned stamp from the Bee API directly instead:

```bash
# Buy stamp (amount=500000000, depth=20)
# The amount must exceed ~414720000 — the local chain's price (24000)
# times Bee's 17280-block (~24h) minimum validity.
curl -X POST "http://localhost:1633/stamps/500000000/20"

# Wait ~30 seconds, then verify it's usable:
curl "http://localhost:1633/stamps/<batchID>"
```

See the [Local Development guide](https://swarm.snaha.net/docs/local-development) for client-side stamp signing, known dev keys, SSH tunnel setup, and more.

### Paying for storage locally

Extending and resizing a drive costs money, and the payment is cross-chain: the user pays on
whatever chain they hold funds on, and xDAI arrives on Gnosis. That leg runs on
[Relay Protocol](https://relay.link), an intent/solver network — its quotes come from a hosted API
and its deliveries from off-chain solvers paying out on real Gnosis, so **no local chain can make a
real payment complete**. What can be rehearsed is everything around it, against a second local
chain: your wallet signs a genuine deposit there, and the Gnosis-side chain's faucet plays the
solver.

```bash
pnpm dev:local         # everything: cluster, both chains, solver, identity UI, demo
pnpm dev:local:fresh   # the same, from a clean chain and empty node state
pnpm dev:local:stop    # tear the containers down
```

| What                         | Where                   |
| ---------------------------- | ----------------------- |
| Identity UI                  | `http://localhost:5500` |
| Demo                         | `http://localhost:3500` |
| Queen Bee API                | `http://localhost:1633` |
| Gnosis-side chain (100)      | `http://localhost:9545` |
| Payment source chain (31337) | `http://localhost:8546` |

The containers run in the background; the solver, UI and demo run in the foreground so you can
watch each delivery land. Re-running `dev:local` is a no-op for whatever is already up.

Reach for `dev:local:fresh` when the chain has drifted — every purchase trades against a real,
thin BZZ pool, and this restores the baked snapshot (it also wipes node state, so drives you
created earlier will point at batches that no longer exist; clear the UI's site data too).

Then, once: open the UI → **Settings** → **Network settings** → **Use local** → **Save**.

#### From a fresh clone, end to end

Everything below runs offline against the committed chain snapshot. You need Docker, and a
browser wallet (MetaMask or similar) — no funds, no testnet, no account anywhere.

```bash
pnpm install
pnpm dev:local          # first run compiles Bee from source; later runs are seconds
```

Wait for `local solver: watching for deposits to 0x…`, then in the browser:

1. **http://localhost:5500** → **Get started**, and create an identity (a password is quickest).
   Choose **Stay local for now** when offered.
2. **Settings** (top right) → **Network settings** → **Use local** → **Save**. It finds whichever
   local chain is running.
3. **http://localhost:5500/dev** → **Chain** tab → **Create drive to test with**. That buys a real
   depth-20 batch on the local chain, owned by your account's own postage signer, and attaches it
   as a drive. Takes ~30s. The banner above the tabs should read _Local dev chain, nothing here is
   real_.
4. Back to **http://localhost:5500** → **Storage** tab → expand the drive → **Extend lifespan**.
   Pick **years** and bump it to 3 — a small extend is covered by the batch's leftover funds and
   never asks for payment, which is the most common reason the payment screens "don't appear".
5. **Proceed** → **Connect wallet** → pick your wallet. It will offer to add _Local source chain_
   and switch to it: accept. Nothing to configure, and no key to import — the chain funds whatever
   account you connect.
6. Review the quote, **Pay with your wallet**, approve the transaction. Watch the `[solver]` lines
   in your terminal report the delivery, then the drive's lifespan grows.

What just happened: your wallet really signed a deposit on one chain; a separate solver process saw
it and paid out on another; that xDAI was swapped for BZZ through a real SushiSwap pool; and the
batch was topped up on the real PostageStamp contract in a single atomic EIP-7702 transaction.

To check the automated suites too:

```bash
pnpm check:all                                   # lint, types, unit tests
pnpm --filter @swarm-id/multichain test:fork     # on-chain, needs pnpm dev:chain:detach
pnpm --filter @swarm-id/ui test:e2e              # browser, needs pnpm dev:local
```

Now extend a drive. Your wallet is prompted to add the source chain and approve one transaction —
nothing else to configure, and no keys to import: the chain funds whatever account you connect.

**Where the solver fits.** The browser signs the deposit and then waits for money it does not
control, exactly as it waits on Relay; `multichain/src/local-solver.ts` is what watches the source
chain and pays out from the Gnosis-side faucet. The deposit carries its own delivery instruction in
its calldata, so the solver is stateless. Stop the solver and a payment hangs and then fails —
which is what a solver outage looks like.

**What this does and does not prove.** The Gnosis side is genuine — the delivered xDAI is swapped
for BZZ through a real SushiSwap pool and spent against the real PostageStamp contract, as a single
atomic EIP-7702 transaction using the same delegate contract mainnet uses. The rail
itself is not: its prices are invented, its step list is shorter than Relay's (an ERC-20 source
would need an approval first), and its failure and refund behaviour is nothing like the real one.
It rehearses the payment **experience** — connect, switch chain, quote, approve, progress, cancel,
resume — which is otherwise untestable outside production.

With no source chain running there is no rail at all: funding falls back to a direct faucet
transfer, the payment screens never open, and the drive test suites run unchanged. See
[docs/Drive-Payment-Flow.md](docs/Drive-Payment-Flow.md).

### Developer Tools (/dev route)

The Identity UI includes a Developer Tools page at http://localhost:5500/dev with utilities for local development:

- **Overview**: Quick start guide and local Bee endpoint links with copy buttons
- **Stamps**: Buy postage stamps from the local Bee node using pre-funded signer keys
- **Sync**: Manually trigger account sync to test postage stamp utilization tracking

## Project Structure

```
.
├── lib/                  # @snaha/swarm-id TypeScript library
├── ui/                   # Identity UI (SvelteKit + Tailwind v4 + shadcn-svelte style)
├── demo/                 # Demo app (SvelteKit)
└── docs-site/            # Documentation website (Starlight/Astro)
```

## Troubleshooting

### Demo not loading

- Check if ports 3500 and 5500 are already in use: `lsof -i :3500 -i :5500`
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
