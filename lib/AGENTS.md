# Library Core (`lib/`)

- **SwarmIdClient** (`swarm-id-client.ts`) — dApp-side: embeds hidden iframe, creates auth buttons, proxies Bee API calls
- **SwarmIdProxy** (`swarm-id-proxy.ts`) — iframe-side: reads auth from the trusted domain's shared localStorage when the embedding page is same-site, or from the connect popup's handover when the browser partitions its storage; signs operations; a peer on the account bus either way

## Message Protocol

All cross-origin communication via `postMessage` with Zod validation:

- **Parent → Iframe**: `parentIdentify`, `checkAuth`, `requestAuth`, `uploadData`, `downloadData`
- **Iframe → Parent**: `proxyReady`, `authStatusResponse`, `authSuccess`, `uploadDataResponse`, `error`

Two authentication paths, decided by the storage probe (`utils/storage-probe.ts`):

- **Unpartitioned**: popup writes to localStorage → storage event fires in the iframe → the iframe authenticates from shared storage.
- **Partitioned**: popup → `window.opener.postMessage(setSecret)` with the account's synced projection → `handlePopupMessage` hydrates an in-memory account view and keeps the handover under `swarm-id-partition-session`, so a reload restores it. No storage event ever fires on this path.

## Account bus (`bus/`)

Live contexts of one account (proxy iframes across partitions and devices, the SwarmID tab) also talk over the account bus — `BroadcastChannel` inside a partition, an encrypted WebRTC/relay mesh via the signaling server across them. Message kinds (`bus/messages.ts`, Zod-validated on receive): `account-delta` (a snapshot, LWW-folded like a feed payload), `lease-request` / `lease-claim` / `lease-released` (partition handover fast path), `presence` (20 s liveness beat feeding the rival set), and `utilization-updated` (local transport only). Durable truth stays in storage and the Swarm feeds; the bus only makes live peers converge fast. Design: `docs/Account-Bus.md`.

## Testing

- **TDD for `lib/` fixes**: when fixing a bug in `lib/`, always work TDD-style if
  applicable — write a failing test that reproduces the bug first, then fix, then
  confirm the test passes (pure refactors/docs are exempt)
