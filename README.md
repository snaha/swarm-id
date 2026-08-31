# Swarm Identity Management

Cross-browser compatible authentication and identity management for Swarm dApps.

**[Documentation](https://swarm.snaha.net/docs)** | **[Identity UI](https://swarm-id.snaha.net)** | **[Demo](https://swarm-demo.snaha.net)**

## Packages

- **[lib/](./lib/README.md)** — `@snaha/swarm-id` TypeScript library for authentication and Bee API operations
- **[ui/](./ui/README.md)** — `@swarm-id/ui` SvelteKit identity UI (trusted domain)
- **[demo/](./demo/)** — Demo dApp with library integration examples
- **[docs-site/](./docs-site/)** — Starlight (Astro) documentation website

## Architecture

The project uses an OAuth-style popup authentication flow over shared localStorage — no Storage Access API and no browser extension. The proxy iframe reads the trusted domain's first-party store while the embedding page is same-site, which covers the local rig and both deployments; where the two are cross-site, or the browser partitions regardless (Safari's ITP, strict privacy settings elsewhere), the connect popup hands the iframe the account's upload credentials directly instead, so uploads keep working ([Account bus](./docs/Account-Bus.md)). The credential handover is confirmed on real Safari (iOS 18.7 / Safari 26.6); the upload that follows it is still verified only on Chromium and Firefox with third-party storage partitioned, see [Safari limitations](#safari-limitations).

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

**Note:** On Safari the proxy iframe's storage is partitioned, so it is re-seeded by the connect popup on every load. A session that was handed no credentials (an older identity deployment) or whose account has no usable postage batch stays download-only; `ConnectionInfo.uploadUnavailableReason` says which. See [Safari limitations](#safari-limitations).

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

For local development with postage stamps and uploads, use [@snaha/bee-compose](https://www.npmjs.com/package/@snaha/bee-compose) to run a local Bee cluster with blockchain. Requires Docker.

```bash
# Start cluster (queen + 3 full workers)
pnpm dev:cluster:start

# View logs
pnpm dev:cluster:logs

# Stop cluster
pnpm dev:cluster stop

# Fresh start (purge data; add --pull after a bee-compose bump)
pnpm dev:cluster:start --fresh
```

**Endpoints:**

| Service        | URL                      |
| -------------- | ------------------------ |
| Queen Bee API  | `http://localhost:1633`  |
| Worker 1 API   | `http://localhost:16331` |
| Blockchain RPC | `http://localhost:9545`  |

**Getting a Postage Batch:**

The easiest way is to use the Developer Tools page in the Identity UI:

1. Navigate to http://localhost:5500/dev
2. Go to the **Chain** tab and select an account
3. Click **Create drive to test with** — it buys a real batch on the local chain, owned by that
   account's own postage signer, and attaches it as a drive

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

### Paying for storage locally

Buying, extending and resizing a drive all cost money, and the payment is cross-chain: the user
pays on whatever chain they hold funds on, and xDAI arrives on Gnosis. That leg runs on
[Relay Protocol](https://relay.link), an intent/solver network — its quotes come from a hosted API
and its deliveries from off-chain solvers paying out on real Gnosis, so **no local chain can make a
real payment complete**. What can be rehearsed is everything around it, against a second local
chain: your wallet signs a genuine deposit there, and the Gnosis-side chain's faucet plays the
solver.

Where the chain carries the EIP-7702 delegate, as Gnosis mainnet does, the postage calls run as one
atomic transaction. The baked snapshot cannot carry it — a state dump only keeps storage the bake
wrote — so locally they run one at a time until something splices the delegate in, which `/dev` →
**Chain** → **Create drive to test with** does.

That is the payment dialog's **built-in** method. The other one, `Pay with crypto (fund.bzz.limo)` —
the default when buying a drive — settles on Gnosis **mainnet** only, so locally there is nothing for
it to settle against: pick the built-in method to pay on the local chain, or turn on `/dev` →
**Chain** → **Simulated purchase**, which stands in for the widget with a fabricated batch so that
method's own screens stay reachable here. (It is also offered for buying alone; its contract ABI
cannot top up or dilute, so extend and resize list the built-in method by itself.)

```bash
pnpm dev:local         # everything: cluster, both chains, solver, identity UI, demo
pnpm dev:local:fresh   # the same, from a clean chain and empty node state
pnpm dev:local:stop    # tear the containers down
```

| What                         | Where                    |
| ---------------------------- | ------------------------ |
| Identity UI                  | `http://localhost:5500`  |
| Demo                         | `http://localhost:3500`  |
| Queen Bee API                | `http://localhost:1633`  |
| Gnosis-side chain (100)      | `http://localhost:9545`  |
| Payment source chain (31337) | `http://localhost:31337` |

**The quickest way to rehearse a payment is to pay from Gnosis**, which needs no bridge: point the
wallet at `http://localhost:9545` (chain 100, offered as _Gnosis Chain (fake)_) and the payment is
a plain xDAI transfer to the batch owner — no source chain and no solver involved at all. Paying
from _Ethereum Mainnet (fake)_ on `:31337` is the bridged route, and that one does need the solver.

The containers run in the background; the solver, UI and demo run in the foreground so you can
watch each delivery land. Re-running `dev:local` is a no-op for whatever is already up.

`/dev` → **Chain** → **Wallet networks** adds the local chains to MetaMask so a balance shows before
you reach the payment screens, and the **Faucet** beside it stocks the account you connect with —
**Use connected wallet** fills its recipient with the address you would be paying from, which is the
one that has to hold something. Nothing funds the payer for you: the wallet must already hold what it
pays with.

Reach for `dev:local:fresh` when the chain has drifted — every purchase trades against a real,
thin BZZ pool, and this restores the baked snapshot (it also wipes node state, so drives you
created earlier will point at batches that no longer exist; clear the UI's site data too).

Chain id alone cannot tell the local chain from the real one — it answers as 100 deliberately — so
before anything is signed the app compares **genesis hashes**, which a chain cannot borrow, against
the endpoint's own. It refuses in words whenever the two are not the same chain: your wallet on real
Gnosis while the app is pointed at the local one, the reverse, or a wallet simply left on some third
network. That is what stops a rehearsal spending real xDAI.

**Already have the real Gnosis in MetaMask? Remove it while rehearsing.** MetaMask keys networks by
chain id, so a switch to 100 lands on whichever RPC is active for it — usually the real one. The app
detects the mismatch by genesis and offers its own RPC, but MetaMask refuses to adopt an RPC for an
id it already serves ("network already exists"), so the offer cannot repair it for you: remove the
real Gnosis network from MetaMask first (or select the local RPC by hand in that network's menu),
and add it back when you are done. The fake mainnet has no such trap — 31337 collides with nothing.

Then, once: open the UI → **Settings** → **Network settings** → **Use local** → **Save**.

**Where the solver fits.** The browser signs the deposit and then waits for money it does not
control, exactly as it waits on Relay; `multichain/src/local-solver.ts` is what watches the source
chain and pays out from the Gnosis-side faucet. The deposit carries its own delivery instruction in
its calldata, so the solver is stateless. Stop the solver and a payment hangs and then fails —
which is what a solver outage looks like.

**What this does and does not prove.** The Gnosis side is genuine — the delivered xDAI is swapped
for BZZ through a real SushiSwap pool and spent against the real PostageStamp contract, as a single
atomic EIP-7702 transaction using the same delegate contract mainnet uses. The rail
itself is not: its prices are invented, and its failure and refund behaviour is nothing like the
real one. The step shape is mirrored — paying in ETH is one signature, paying in the mock USDC is
approve-then-deposit with the solver pulling the token, as on Relay. It rehearses the payment
**experience** — connect, switch chain, quote, approve, progress, cancel, resume — which is
otherwise untestable outside production.

With no source chain running the bridged route simply is not offered; paying from Gnosis
still is, and it needs no solver. Funding never falls back to a free transfer. See
[docs/Drive-Payment-Flow.md](docs/Drive-Payment-Flow.md).

### Developer Tools (/dev route)

The Identity UI includes a Developer Tools page at http://localhost:5500/dev with utilities for local development:

A menu in the header switches the whole app between the local and production endpoints, and a
banner names the chain the configured RPC actually serves — so it is always visible whether these
tools would be spending real money.

- **Overview**: Live endpoint status, a link into the demo app's connect flow, and local-data counters
- **Chain**: Faucet, on-chain batch and test-drive creation, batch import by ID, and the mock
  purchase toggles for the **Add drive** flow
- **Node**: Stored stamps, retrievability checks, manual sync, and partition tuning
- **Devices**: The devices registered to an account and the partitions they hold

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

Safari's Intelligent Tracking Prevention (ITP) partitions storage for third-party iframes, so the proxy cannot read the trusted domain's localStorage. Uploads are designed to keep working regardless: the connect popup hands the iframe the account's synced projection (postage stamps including their signer keys), and cross-context coordination rides the [account bus](./docs/Account-Bus.md) instead of storage events.

> **Status: the handover is confirmed on real Safari; the upload is not yet.** Measured on iOS 18.7 / Safari 26.6 against the deployed sites (`swarm-demo.snaha.net` → `swarm-id.snaha.net`): ITP partitions the proxy iframe, and the connect popup's `postMessage` through `window.opener` reaches it. That was the one thing only real WebKit could settle, and it holds — the session authenticates on the partitioned path.
>
> Still open: an upload from that session, end to end on the device. The run that settled the handover used an account with no postage batch, so it never reached the write path. Everything below the handover — hydrating the account view, building the stamper, stamping and pushing chunks — remains verified only on Chromium and Firefox with third-party storage partitioned. Treat Safari **upload** support as expected-but-unverified until this section says otherwise.

What remains regardless:

- **Credentials are per page load.** Nothing is persisted in the partition, so a reload re-runs the popup handshake.
- **Live propagation needs a signaling server.** Without one configured, a partitioned iframe only talks to contexts in its own partition.
- **Safari private mode**: Sessions are ephemeral (lost when the private window closes).

See [#277](https://github.com/snaha/swarm-id/issues/277) for the background.

## Contribute

We have a separate [guide document](CONTRIBUTING.md) if you want to contribute to the project.

## License

[Apache 2.0](LICENSE)
