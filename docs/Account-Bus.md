# Account bus — live state propagation across tabs, partitions, and devices

Status: **proposed** (design accepted 2026-08-18, not yet implemented). Resolves
[#277](https://github.com/snaha/swarm-id/issues/277) (Safari is download-only) by making the
Safari iframe a full participant, and unifies cross-tab/cross-device propagation on every
browser. Builds on the account model in [`Account-State.md`](./Account-State.md) and the write
coordination in [`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md) /
[`Postage-Batch-Partitioning.md`](./Postage-Batch-Partitioning.md).

## Problem

Safari's Intelligent Tracking Prevention partitions all client-side storage of a third-party
iframe by top-level site. The SwarmID proxy iframe embedded in a dApp therefore cannot see the
trusted domain's first-party localStorage; today the connect popup hands over only the
`appSecret` via postMessage (`ui/src/lib/connect-handshake.ts`, `sendSecretToOpener`), and all
state-mutating operations are disabled (`ensureCanUpload`, `lib/src/swarm-id-proxy.ts`) because
changes made in the partitioned iframe could never be synchronized back.

Two distinct problems hide in "synchronized back":

- **P1 — account-data propagation.** Changes to account data (app secrets and revocations,
  account name, settings, the postage stamp list — never the private key/seed) must propagate
  between SwarmID tabs, dApp proxy iframes, and devices. Swarm feed sync covers synced
  accounts, but **local (non-synced) accounts need a channel too**, so Swarm cannot be the only
  transport.
- **P2 — batch-utilization coordination.** Uploads consume stamp slots; the partition-lease
  protocol coordinates writers that cannot talk to each other, so its timeouts are
  conservative (~10 s for a late device to acquire a partition). Treating every Safari dApp
  partition as a separate device would multiply that contention. The lease protocol must stay
  (it is the offline-safe fallback) but live contexts deserve a fast path.

Constraint carried through the whole design: Swarm's upcoming pub-sub
([SWIP-60](https://github.com/ethersphere/SWIPs/pull/104)) must be able to plug in later
without an architecture change.

## What the research established

Full option matrix in the appendix; the load-bearing facts:

- **There is no browser-native fix.** Safari's Storage Access API unlocks unpartitioned
  _cookies_ only; the non-cookie extension (`requestStorageAccess({localStorage: true})`) is
  shipped in Chrome 125+ but has no WebKit position or implementation through Safari 26.x
  ([WebKit/standards-positions#262](https://github.com/WebKit/standards-positions/issues/262)).
  FedCM is unimplemented in Safari; Partitioned Popins was withdrawn (Nov 2025). Not
  plannable.
- **ITP partitions storage, not the network.** A partitioned iframe can open HTTPS/WSS to
  anything — the Bee node, a signaling server, another peer. Every network-based design is
  Safari-safe.
- **The key material is the actual blocker, not the partition.** The per-device-feed sync of
  [`Account-State.md`](./Account-State.md) already handles "another storage area that folds in
  later". The partitioned iframe cannot join only because the popup handshake never sends the
  `derivationKey`, so it cannot derive the backup key that owns the sync feeds. The
  `AuthDataSchema` (`lib/src/types.ts`) already has unused `postageBatchId` / `signerKey` /
  `networkSettings` slots.
- **WebRTC works between the contexts we have, but only while both are alive.** DataChannels
  are available in Safari cross-origin iframes (only `getUserMedia` is permission-gated), and
  same-device loopback needs no STUN/TURN. There is no store-and-forward — which is acceptable
  precisely because durable truth stays in storage (below).
- **SWIP-60 is real-time-only and pre-release.** Draft spec (Aug 2026), bee
  [PR #5435](https://github.com/ethersphere/bee/pull/5435) and bee-js
  [PR #1151](https://github.com/ethersphere/bee-js/pull/1151) open, in no release; history
  delivery is explicitly deferred to a future SWIP. Its `FEED_TOPIC` cohort binding makes an
  ordinary sequence feed the pub-sub topic (`id = keccak256(topic ‖ index)`), so a feed-based
  design gets broker push later with zero data-model change.
- **No third-party networks.** Public Nostr relays / MQTT brokers / Waku would work
  technically, but none offers guarantees appropriate for this application, and a dependency
  on an unrelated decentralized network is unacceptable. A small centralized service **we
  run** is fine — ideally used only for WebRTC signaling, with data flowing peer-to-peer.

## Design

### The account bus

A pluggable **real-time message bus between all live contexts of one account**: dApp proxy
iframes (across partitions and dApps), SwarmID tabs, and the same account's contexts on other
devices. The topic is derived per account; envelopes are end-to-end encrypted with an
account-derived key and validated with Zod schemas like every other message boundary in the
codebase.

**Durable truth does not move.** First-party localStorage (and, for synced accounts, the Swarm
feeds of [`Account-State.md`](./Account-State.md)) remain the stores of record. The bus carries
only _deltas and coordination between live peers_ — which is why WebRTC's
"both-peers-online-or-nothing" property is acceptable by design rather than a flaw.

One interface, three transports:

| Transport                                       | Scope                                                                 | Status                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `BroadcastChannel`                              | same origin + same partition (SwarmID tab↔tab, same-dApp Safari tabs) | works today; generalizes the existing `BroadcastChannel("swarm-id-utilization")` channel    |
| WebRTC DataChannel mesh, self-hosted signaling  | across partitions, dApps, and devices                                 | new; signaling is a tiny WebSocket service we deploy next to the existing DigitalOcean apps |
| SWIP-60 (`pubsubConnect`, `FEED_TOPIC` binding) | synced accounts, once bee/bee-js release it                           | future adapter behind the same interface                                                    |

The signaling WebSocket **doubles as an encrypted-blob relay fallback** for peer pairs WebRTC
cannot connect (restrictive NATs — we start without TURN), and optionally as a small
retained-message mailbox so a change can reach a currently-closed dApp partition of a local
account. Same service, no extra infrastructure; the default posture stays signaling-only.

### Message kinds

- **Account deltas (P1).** The wire shape is the existing portable projection
  (`serializeSyncedAccount`, `lib/src/utils/storage-managers.ts`) and merging reuses the LWW
  fold rules of `lib/src/sync/merge-snapshot.ts` — a delta received over the bus merges
  exactly like a device-state feed payload. Revocation notices ride the same channel so a live
  iframe drops its session immediately.
- **Coordination (P2).** Lease negotiation/handover requests and utilization deltas. Live
  peers release or transfer a partition sub-second; if nobody answers, the existing
  conservative Swarm lease protocol ([`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md))
  proceeds unchanged as the safety net.

### Safari write enablement

With the bus in place the partitioned iframe becomes a first-class writer:

- The connect popup sends the full `AuthData` — an `account` field carrying the
  **synced-account projection** (`serializeSyncedAccount`: `derivationKey`, stamps incl.
  signer keys; no vault, no app secrets) plus `networkSettings`. (Sending only derived keys
  was considered and rejected: the encrypted on-Swarm account state contains the
  `derivationKey` anyway, so holding the derived keys is equivalent — derived-only would be
  defense-in-depth theater.)
- `handlePopupMessage` hydrates the projection into an **in-memory** account view
  (`partitionAccount`): the stored-account schema deliberately quarantines vault-less
  records, and partitioned sessions already re-handshake per iframe load, so nothing is
  persisted. The popup hands over a freshly-loaded view, so no extra on-hydrate fold is
  needed; the iframe keeps its own `swarm-id-device-id` and lease cache — it _is_ a device.
  (Roster naming/expiry policy for per-dApp partition devices: follow-up.)
- On successful hydration `uploadMode` flips to `user-stamp` and `ensureCanUpload` passes;
  `storagePartitioned` stays surfaced in `ConnectionInfo` for UI messaging.

### Why this shape

- On Safari, during normal dApp use the iframe is often the **only** live context — so
  correctness must never depend on the bus, only latency does. That is exactly the split
  between durable stores (unchanged) and bus (fast path).
- One code path everywhere: Chrome/Firefox cross-tab propagation moves onto the same bus
  (BroadcastChannel transport) instead of bespoke storage-event plumbing, and cross-device
  propagation gets faster on every browser. Safari stops being a special case.
- The bus interface is the SWIP-60 seam. Its brokered per-topic model maps 1:1; adopting it
  is a transport adapter, not a redesign.

## Implementation phases

Each phase is an independent PR chain:

1. **Bus core + BroadcastChannel transport** (`lib/src/bus/`): interface, encrypted envelope
   schema, account-topic derivation; wire account-delta messages into the existing
   storage-event plumbing (`handleAccountStorageChange`, `swarm-id-storage-write`). Zero new
   infrastructure.
2. **Signaling service + WebRTC transport**: minimal self-hosted WebSocket signaling
   (a bespoke ~180-line `ws` server was chosen over Trystero's `ws-relay` — the relay
   fallback and per-peer targeting are not in Trystero's protocol, and the bespoke server
   stays dependency-light), the DataChannel mesh transport, and the signaling-WS
   blob-relay fallback. Deployed as a `services:` entry in `.do/swarm-id-app.yaml`
   (`wss://swarm-id.snaha.net/bus`).
3. **Safari write enablement**: widen `AuthData` and `sendSecretToOpener`, hydration in
   `handlePopupMessage`, roster naming/expiry for partition devices, flip the upload gate.
4. **Bus-accelerated leases**: fast-path handover and live utilization deltas through
   `BatchWriteCoordinator`'s existing dependency-injection seams (`readLeaseCache` /
   `writeLeaseCache` / `onLeaseChange`); the Swarm SOC protocol is untouched as fallback.
5. **SWIP-60 transport adapter** once bee/bee-js release it.

## Verification

- Unit (Vitest, TDD): envelope encryption/schema, "delta merged over bus ≡ delta merged from
  feed payload", lease fast-path state machine.
- Playwright e2e against the local bee cluster plus a dev signaling server (docker-compose):
  two isolated contexts propagating a rename/revocation over the bus; partitioned-mode
  connect → upload succeeds → a second context observes the utilization/lease state; lease
  handover sub-second with both peers live, timeout fallback with one peer killed.
- Manual Safari (macOS) smoke test against staging, under real ITP.

## Known gaps

- A revocation reaches a **closed** dApp partition only at the next live overlap or popup
  re-handshake, unless the signaling-mailbox option is enabled.
- Without TURN, WebRTC will not connect across restrictive NATs; those pairs fall back to the
  signaling-server relay.
- Safari evicts partitioned (and even first-party) script-writable storage after 7 days
  without site interaction; re-handshakes re-seed the partition, as they already do for the
  `appSecret` today.

## Appendix — alternatives considered

| Option                                                                 | Verdict                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage Access API (non-cookie extension), FedCM, Partitioned Popins   | No Safari implementation or timeline; cookie-only SAA also demands a prior first-party visit + gesture + prompt. Dead end.                                                   |
| "Safari iframe as a device" over Swarm feeds alone                     | Sound for synced accounts and kept as the durable layer, but excludes local accounts (P1) and inherits the slow lease UX unaccelerated (P2).                                 |
| Third-party store-and-forward relays (Nostr NIP-78, public MQTT, Waku) | Right semantics, wrong dependency: no guarantees from unrelated networks (Nostr), test-only ToS (public MQTT), heavy/pre-1.0/mid-rebrand (Waku → Logos). Rejected.           |
| Popup performs all writes (Coinbase keys.coinbase.com model)           | Keeps keys first-party but costs a visible popup per upload session, fights popup blockers/gesture rules, and iOS popup lifetimes are fragile.                               |
| PSS / GSOC subscribe in the browser                                    | Receiving requires operating a full node in the mined neighborhood; GSOC is a doorbell (last message only), not a mailbox. Revisit as a doorbell once we run infrastructure. |
| WebRTC as the _primary_ channel                                        | No store-and-forward, so unusable alone; adopted instead as the live fast path over durable stores — which is this design.                                                   |
