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
  proceeds unchanged as the safety net. Utilization deltas are **lane-scoped**: the buckets
  carry the writer's per-partition counter `j`, not an absolute slot
  (`slot = partitionCount + partition + partitionCount·j`), so the message names its lane and
  a receiver folds it in only when the lane matches. Since leases are exclusive, this means a
  delta is shared between contexts of the same holder and dropped everywhere else — the bus
  widens its reach, not the set of contexts a counter is comparable across.

### Safari write enablement

With the bus in place the partitioned iframe becomes a first-class writer:

- The connect popup sends the full `AuthData` — an `account` field carrying the
  **synced-account projection** (`serializeSyncedAccount`: `derivationKey`; no vault, no app
  secrets) plus `networkSettings`. (Sending only derived keys was considered and rejected: the
  encrypted on-Swarm account state contains the `derivationKey` anyway, so holding the derived
  keys is equivalent — derived-only would be defense-in-depth theater.)
- **What the partitioned session is allowed to hold** (#578). The stamp collection is narrowed
  to the batches this app's own pointers name — its `postageStampBatchID` override and the
  account default it falls through to (`stampsReachableByApp`) — at the handover AND after
  every `account-delta` fold, since the publisher is an unpartitioned context that sends the
  whole collection. A session can only ever spend the stamp `resolveStampForApp` picks, so
  every other signer key it held was exposure with no use.

  The `derivationKey` **stays**, and that is the trade-off worth stating rather than leaving
  implicit: the bus derives its topic and envelope key from it (`deriveBusContext`), and the
  partition lease derives the Swarm encryption key and the lock-SOC signer from it
  (`deriveSwarmEncryptionKey` → `backup-key`). A partitioned session cannot write without it.
  So this is least privilege, not a boundary being closed — the iframe is on the SwarmID
  origin, and an unpartitioned proxy reads the same material out of shared storage. What
  changed with #547 is that a partitioned session went from holding no credentials at all to
  holding real ones, in a context embedded by an arbitrary dApp page; narrowing the collection
  reduces what it holds at rest.

  It does **not** bound what script execution in that iframe would yield. The session keeps the
  `derivationKey`, so it can derive the envelope key and read the room — and every
  `account-delta` a publisher sends carries the whole stamp collection, signer keys included,
  because the publisher is unpartitioned and does not know which app each receiver is. Anything
  running there can wait for one message. Narrowing that too means publishing per-app deltas,
  which needs a per-app room; not in scope here, and worth stating so the next reader does not
  mistake this for a boundary.

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
4. **Bus-accelerated leases**: a slot-waiting acquire broadcasts `lease-request` each poll
   round (`onSlotWait` dep) with a fresh 8-hex `requestId`; an idle live holder yields via
   the normal idle-yield release path (`yieldForPeer`, guarded by `PEER_YIELD_MIN_IDLE_MS`
   and the in-flight upload count, under the write lock) and answers `lease-released`,
   which wakes the waiter's poll sleep (`notifySlotMaybeFree`) — handover in ~one bus
   round-trip instead of the 10 s `LEASE_REFRESH_MS` poll. The Swarm lock-SOC protocol is
   untouched as the authority and offline fallback.

   **Exactly one holder answers** (#576). A waiter needs one slot, but the request names no
   partition, so every idle holder used to release at once and whoever lost the re-race got
   "Uploads are unavailable". Every holder that would presently yield (`canYieldForPeer`)
   derives the same permutation of the partitions from the `requestId` and waits its own
   rank in it — `rank = (requestId₁₆ + partition) % partitionCount`, `PEER_YIELD_RANK_STEP_MS`
   apart. Rank 0 answers immediately, so a single-holder handover is not slowed at all.

   The winner publishes **`lease-claim` before it starts releasing**, and later ranks stand
   down on that: releasing is two stamped Swarm writes, so a signal sent on completion would
   reach them only after they had all begun releasing too. `lease-released` still carries
   the `requestId` and also stands holders down, covering a missed claim. If the winner then
   declines (an upload slipped in), the round goes unanswered and the next one draws a fresh
   id. `requestId` is optional on the wire — a peer on an older bundle is answered the way
   it always was — but a present one must be `^[0-9a-f]{8}$`, since it is parsed straight
   into the rank seed.

   The waiter's wake is **sticky for one round** (#582): the answer usually lands during the
   `acquire()` at the top of the poll loop — it is a reply to the request that loop
   broadcast one line earlier — where there is no sleep to wake and the scan it interrupts
   read the state from before the release. The flag lives on a per-wait state object, so a
   wait left running detached by `ensureLease`'s timeout race cannot clear the live one's,
   and it skips at most one sleep per wait (each round re-broadcasts, so an unconditional
   skip would be one acquire per bus round-trip).

5. **SWIP-60 transport adapter** once bee/bee-js release it.

## Verification

Done:

- Unit (Vitest, TDD): envelope encryption/schema, "delta merged over bus ≡ delta merged from
  feed payload", lease fast-path state machine, lane-scoped utilization deltas, partitioned
  hydration. The relay tests run the real signaling server; WebRTC is faked.
- Playwright e2e over the real signaling server (`ui/tests/bus-propagation.test.ts`, #569): a
  genuinely partitioned proxy iframe — the demo browsed under a loopback literal while the proxy
  origin stays `localhost`, so the two are cross-site — reached by an app removal published from
  the SwarmID tab, and a partitioned connect whose upload round-trips. The partition itself is
  asserted first, because Playwright's default chromium args turn third-party storage
  partitioning off and a suite that skips that check proves nothing.

Planned — **not yet written**, do not read the list above as covering these:

- The **rename** half of the propagation pair (#569): a cross-device rename does not reach a
  partitioned session at all today — `applyAccountDelta` folds the collections, never the
  metadata scalars — so the e2e above asserts the current behaviour and #610's scalar fold is
  what changes it.
- A second context observing the utilization/lease state, and lease handover — sub-second with
  both peers live, timeout fallback with one peer killed. These extend
  `lib/test/live/multi-device-acquire-upload.test.ts`, not the Playwright rig.
- Manual Safari (macOS) smoke test against staging, under real ITP — until it lands, Safari
  upload support is expected-but-unverified (see the README).

## Known gaps

- A revocation reaches a **closed** dApp partition only at the next live overlap or popup
  re-handshake, unless the signaling-mailbox option is enabled.
- Without TURN, WebRTC will not connect across restrictive NATs; those pairs fall back to the
  signaling-server relay.
- Safari (ITP) deletes script-writable storage for sites without first-party user
  interaction. The window is **30 operational days** by default since a Feb 2024 WebKit
  change ([`DataRemovalFrequency`](https://github.com/WebKit/WebKit/commit/45061230013728ec9c4900b01b12af26dc592b4b));
  the widely-cited 7 days now applies only to sites reached cross-site with unfiltered
  link decoration from a classified domain (webkit.org's docs predate the change).
  Impact here: partitioned iframe storage is re-seeded per popup handshake (harmless),
  and every Safari connect is a first-party click in the popup that resets the trusted
  domain's clock. The residual risk is a **dormant local account's vault**
  (`encryptedSeed`, the only copy of the seed) after >30 operational days with no
  connect; synced accounts restore from Swarm.
  **`navigator.storage.persist()` is NOT a mitigation** (checked against WebKit source,
  2026-08): WebKit grants it only to origins _already exempt_ from ITP deletion
  (home-screen/Dock web apps, app-bound/MDM domains — exemption is the grant's
  precondition, not its effect;
  [`fb634d8`](https://github.com/WebKit/WebKit/commit/fb634d8ebf1e903515286602488a23367c6a1e61)),
  it returns `false` unconditionally in cross-origin (partitioned) iframes, and the ITP
  deletion path never consults the persisted marker (it only shields quota-pressure
  eviction). The only real escape hatches: recent first-party interaction, or installing
  the trusted domain as a home-screen/Dock web app.

## Appendix — alternatives considered

| Option                                                                 | Verdict                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage Access API (non-cookie extension), FedCM, Partitioned Popins   | No Safari implementation or timeline; cookie-only SAA also demands a prior first-party visit + gesture + prompt. Dead end.                                                   |
| "Safari iframe as a device" over Swarm feeds alone                     | Sound for synced accounts and kept as the durable layer, but excludes local accounts (P1) and inherits the slow lease UX unaccelerated (P2).                                 |
| Third-party store-and-forward relays (Nostr NIP-78, public MQTT, Waku) | Right semantics, wrong dependency: no guarantees from unrelated networks (Nostr), test-only ToS (public MQTT), heavy/pre-1.0/mid-rebrand (Waku → Logos). Rejected.           |
| Popup performs all writes (Coinbase keys.coinbase.com model)           | Keeps keys first-party but costs a visible popup per upload session, fights popup blockers/gesture rules, and iOS popup lifetimes are fragile.                               |
| PSS / GSOC subscribe in the browser                                    | Receiving requires operating a full node in the mined neighborhood; GSOC is a doorbell (last message only), not a mailbox. Revisit as a doorbell once we run infrastructure. |
| WebRTC as the _primary_ channel                                        | No store-and-forward, so unusable alone; adopted instead as the live fast path over durable stores — which is this design.                                                   |
