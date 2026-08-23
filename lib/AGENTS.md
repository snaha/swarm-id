# Library Core (`lib/`)

- **SwarmIdClient** (`swarm-id-client.ts`) — dApp-side: embeds hidden iframe, creates auth buttons, proxies Bee API calls
- **SwarmIdProxy** (`swarm-id-proxy.ts`) — iframe-side: reads auth from shared localStorage (via storage events), signs operations

## Message Protocol

All cross-origin communication via `postMessage` with Zod validation:

- **Parent → Iframe**: `parentIdentify`, `checkAuth`, `requestAuth`, `uploadData`, `downloadData`
- **Iframe → Parent**: `proxyReady`, `authStatusResponse`, `authSuccess`, `uploadDataResponse`, `error`

Authentication uses storage events: popup writes to localStorage → storage event fires in iframe → iframe authenticates.

## Testing

- **TDD for `lib/` fixes**: when fixing a bug in `lib/`, always work TDD-style if
  applicable — write a failing test that reproduces the bug first, then fix, then
  confirm the test passes (pure refactors/docs are exempt)
