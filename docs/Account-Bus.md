# Account bus — live state propagation across tabs, partitions, and devices

Status: **implemented** ([#547](https://github.com/snaha/swarm-id/pull/547) through
[#655](https://github.com/snaha/swarm-id/pull/655); the SWIP-60 transport adapter is the one
part still pending). Resolves [#277](https://github.com/snaha/swarm-id/issues/277) by making the
Safari iframe a full participant, and unifies cross-tab/cross-device propagation on every
browser. Builds on the account model in [`Account-State.md`](./Account-State.md) and the write
coordination in [`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md) /
[`Postage-Batch-Partitioning.md`](./Postage-Batch-Partitioning.md). The porter-facing
walkthrough is on the docs site (`docs-site/src/content/docs/account-bus.mdx`); this file is
the design record and the place for the reasoning.

## Problem (as designed, 2026-08)

This is the state the bus replaced. Safari's Intelligent Tracking Prevention partitions all
client-side storage of a third-party iframe by top-level site. The SwarmID proxy iframe embedded
in a dApp therefore cannot see the trusted domain's first-party localStorage. Before the bus,
the connect popup handed over only the `appSecret` via postMessage, and every state-mutating
operation was disabled in a partitioned iframe (`ensureCanUpload`) because a change made there
could never be synchronized back.

Two distinct problems hid in "synchronized back":

- **P1 — account-data propagation.** Changes to account data (app secrets and revocations,
  account name, settings, the postage stamp list — never the private key/seed) must propagate
  between SwarmID tabs, dApp proxy iframes, and devices. Swarm feed sync covers synced
  accounts, but **local (non-synced) accounts need a channel too**, so Swarm cannot be the only
  transport.
- **P2 — batch-utilization coordination.** Uploads consume stamp slots; the partition-lease
  protocol coordinates writers that cannot talk to each other, so its timeouts are
  conservative (~10 s for a late device to acquire a partition). Treating every Safari dApp
  partition as a separate device would multiply that contention. The lease protocol had to stay
  (it is the offline-safe fallback) but live contexts deserved a fast path.

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
- **`document.hasStorageAccess()` does not answer "am I partitioned".** Measured 2026-08-31 in
  the `chromium-partitioned` rig: it returns **`true`** inside a frame whose `localStorage` is
  genuinely partitioned. It is cookie-scoped, and Chrome partitions storage separately from
  cookies, so a frame can hold unpartitioned cookies and a partitioned store at once. Anything
  that needs the storage answer has to ask about storage — see the marker probe in
  `lib/src/utils/storage-probe.ts` (#613).
- **ITP partitions storage, not the network.** A partitioned iframe can open HTTPS/WSS to
  anything — the Bee node, a signaling server, another peer. Every network-based design is
  Safari-safe.
- **The key material is the actual blocker, not the partition.** The per-device-feed sync of
  [`Account-State.md`](./Account-State.md) already handles "another storage area that folds in
  later". The partitioned iframe could not join only because the popup handshake never sent the
  `derivationKey`, so it could not derive the backup key that owns the sync feeds.
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

One interface (`BusTransport`, `lib/src/bus/account-bus.ts`), three transports:

| Transport                                       | Scope                                                                 | Status                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `BroadcastChannel`                              | same origin + same partition (SwarmID tab↔tab, same-dApp Safari tabs) | shipped; generalizes the old `BroadcastChannel("swarm-id-utilization")` channel        |
| WebRTC DataChannel mesh, self-hosted signaling  | across partitions, dApps, and devices                                 | shipped and deployed: `signaling/`, reached at `wss://swarm-id.snaha.net/bus` (`.do/`) |
| SWIP-60 (`pubsubConnect`, `FEED_TOPIC` binding) | synced accounts, once bee/bee-js release it                           | future adapter behind the same interface                                               |

The signaling WebSocket **doubles as an encrypted-blob relay** for peer pairs WebRTC cannot
connect (restrictive NATs — there is no TURN). Same service, no extra infrastructure; the
server forwards to exactly one named peer, never to a room, and stores nothing.

Who attaches what: a **proxy iframe** attaches both the local transport and (when a signaling
URL is configured) the signaling transport, a few ticks after an auth event, because the
topic is derived from the account's key (`ensureAccountBusTransports`, `swarm-id-proxy.ts`).
The **SwarmID tab** attaches the signaling transport alone (`ui/src/lib/stores/account-bus.ts`):
everything a `BroadcastChannel` would reach from there already converges through storage
events, and the partitioned iframe — the one context that cannot — is only reachable through a
server round trip.

### How a message travels

Both the topic and the envelope key come from the account's `derivationKey` through separate
HMAC contexts (`deriveBusContext`, `lib/src/bus/bus-context.ts`), so they are derivable by
exactly the contexts that hold the account, and the topic is unlinkable to the account id.

```text
newcomer                         signaling server                       existing peer
   │ ── WSS connect ───────────────────▶ │                                    │
   │ ── {join, topic} ─────────────────▶ │  (topic in the first frame,        │
   │ ◀── {welcome, peerId, peers[]} ──── │   never in the URL: #577)          │
   │                                     │ ── {peer-joined, peerId} ────────▶ │
   │ ── {signal, to, offer} ───────────▶ │ ──────────────────────────────────▶ │
   │ ◀────────────────────────────────── │ ◀── {signal, to, answer} ────────── │
   │ ◀──── ICE candidates both ways, relayed the same way ────────────────────▶ │
   │                                                                          │
   │ ═══════════ RTCDataChannel "bus": encrypted envelopes, direct ══════════ │
   │                                                                          │
   │ ── {relay, to, ciphertext} ───────▶ │ ── {relay, from, ciphertext} ────▶ │
   │         (fallback per peer, whenever no channel is open to that peer)    │
```

- **Join.** The socket names its room in the first frame; the server answers `welcome` with
  the ids of the peers already there and tells them `peer-joined`. A room is a `Map` of
  sockets and nothing else; it is dropped when the last peer leaves.
- **Upgrade.** The newcomer initiates WebRTC toward every peer in `welcome` (so there is no
  offer glare); SDP and ICE travel as `signal` frames addressed to one peer. No STUN/TURN is
  configured: same-device loopback and LAN peers connect via host candidates, everything else
  stays on the relay.
- **Publish.** `SignalingTransport.publish` encrypts the message **once** (AES-GCM, the bus
  key) and then delivers per peer: over that peer's DataChannel if it is open, else as a
  `relay` frame the server forwards as-is. A context alone in its room sends nothing. The
  server sees a room name, connection timing, and ciphertext.
- **Receive.** Every transport hands raw messages to the one `AccountBus`, which validates
  them against `BusMessageSchema` (`lib/src/bus/messages.ts`) and drops what does not parse —
  so a peer on an older bundle simply never sees a message kind it predates.
- **Leave.** The server pings every 30 s and terminates a socket that has not answered by the
  next tick, so a half-open peer (backgrounded mobile Safari, a laptop lid) is announced as
  `peer-left` within about a minute. The client's `close()` drains in-flight publishes first,
  so a teardown announcement made in the closing tick still reaches the wire.
- **No mailbox.** A message reaches the peers that are in the room right now. That is the
  whole design: the bus makes live peers converge fast; it does not carry anything to a
  context that is closed (see Known gaps).

Server limits (`signaling/src/server.ts`, all deliberately global rather than per-IP because
the service sits behind the platform ingress): 500 connections, 200 rooms, 24 peers per room, a
per-socket message budget sized from the WebRTC negotiation cost, a 64 KiB payload cap, and a
join timeout for a socket that never names a room. `1008` closes are permanent for a topic;
everything transient closes `1013` and the client backs off with jitter.

### Message kinds

- **Account deltas (P1).** The wire shape is the existing portable projection
  (`serializeSyncedAccount`, `lib/src/utils/storage-managers.ts`) minus the per-context session
  material (`appSecret`, `connectedUntil` — stripped on send _and_ on receive), and merging
  reuses the LWW fold rules of `lib/src/sync/merge-snapshot.ts` — a delta received over the bus
  merges exactly like a device-state feed payload, metadata scalars included on their per-field
  clocks (#610). Revocation notices ride the same channel so a live iframe drops its session
  immediately.
- **Presence.** Every context beats `{ presence, accountId, fromDeviceId }` on joining the room
  and every 20 s (`lib/src/bus/presence.ts`); a receiver stamps its own clock and forgets a
  device unheard for three minutes — three beats at the once-a-minute cadence a hidden tab's
  timers are throttled to, so a backgrounded device does not flap out of the live set. A clean
  departure does not wait for that window: the server sends `peer-left` when a socket closes,
  its reaper included, and the device that socket carried is dropped at once
  ([#572](https://github.com/snaha/swarm-id/issues/572)). `peer-left` is a **transport** signal,
  not a bus message kind — nothing publishes it, and nothing may. A leave message of our own is
  not an option: a publish encrypts before it sends, and a page being torn down never gets back
  to the send. Ageing is the backstop for what the room cannot see — a peer the server has not
  yet reaped, and a device heard only over the local transport. This is the liveness signal: a peer beating in the room is alive by
  construction, at no Swarm cost, so the partition rival set (`knownDeviceIds`) is the live set
  unioned with the registry's recent sign-ins — the latter only as a bootstrap for a context with
  no bus. Nothing durable is written. A `lastSeenAt` riding the account snapshot was
  considered and rejected: every publish would be a byte change to fold and re-persist, and an
  unpartitioned proxy answers every storage event with a delta and a stamped feed write, so it
  loops without settling, even on one device. Stale devices are therefore _ignored_ at read,
  never tombstoned; the roster grows per device, not per time, and needs no prune.
- **Coordination (P2).** Lease negotiation/handover requests and utilization deltas. Live
  peers release or transfer a partition sub-second; if nobody answers, the existing
  conservative Swarm lease protocol ([`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md))
  proceeds unchanged as the safety net. Utilization deltas are **lane-scoped**: the buckets
  carry the writer's per-partition counter `j`, not an absolute slot
  (`slot = partitionCount + partition + partitionCount·j`), so the message names its lane and
  a receiver folds it in only when the lane matches. Since leases are exclusive, this means a
  delta is shared between contexts of the same holder and dropped everywhere else — the bus
  widens its reach, not the set of contexts a counter is comparable across. They are published
  `localOnly`: every remote peer is a different device on a different lane, so a remote copy
  would be dropped at the receive guard after paying for encryption and a frame.

### Safari write enablement

With the bus in place the partitioned iframe is a first-class writer:

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

- `handlePopupMessage` hydrates the projection into an in-memory account view
  (`partitionAccount`) **and keeps the handover itself** under
  `partitionSessionStorageKey(parentOrigin)` — one per dApp origin, since every same-site dApp
  shares the store (#671) — so a reload restores the session instead of re-running the
  popup (#635). Its own record, not the accounts document: `LocalAccountSchemaV1`
  quarantines vault-less records and the hydrated view carries inert vault placeholders, so
  it could not be stored as an account. The deadline is the same `connectedUntil` the
  unpartitioned path enforces out of shared storage — 30 days by default — and a restored
  session reads the account's published state once, in the background, to catch a revoke made
  while the tab was closed, which reaches it no other way. That read is a revocation check,
  not a fold: everything else still arrives over the bus, and a fold that lands re-persists
  the record so the next reload does not undo it. The iframe keeps its own
  `swarm-id-device-id` and lease cache — it _is_ a device, named after the dApp it belongs to
  in the roster (#643), and its liveness comes from presence like every other device's; nothing
  expires a device (see Message kinds).
- On successful hydration `uploadMode` flips to `user-stamp` and `ensureCanUpload` passes;
  `storagePartitioned` stays surfaced in `ConnectionInfo` for UI messaging. The download-only
  session that used to exist for a handover without an account projection is gone (#642): the
  projection is required, and that requirement is the check.

### Why this shape

- The socket now buys something even for a lone dApp tab: presence is what makes this device a
  rival to every other context of the account, and what tells it who its own rivals are. Any
  gating of the signaling attach ([#581](https://github.com/snaha/swarm-id/issues/581)) has to
  be weighed against that.
- On Safari, during normal dApp use the iframe is often the **only** live context — so
  correctness must never depend on the bus, only latency does. That is exactly the split
  between durable stores (unchanged) and bus (fast path).
- One code path everywhere: Chrome/Firefox cross-tab propagation moves onto the same bus
  (BroadcastChannel transport) instead of bespoke storage-event plumbing, and cross-device
  propagation gets faster on every browser. Safari stops being a special case.
- The socket buys something even for a lone dApp tab: presence is what makes this device a
  rival to every other context of the account, and what tells it who its own rivals are. Any
  gating of the signaling attach ([#581](https://github.com/snaha/swarm-id/issues/581)) has to
  be weighed against that.
- The bus interface is the SWIP-60 seam. Its brokered per-topic model maps 1:1; adopting it
  is a transport adapter, not a redesign.

## What shipped

Each landed as its own PR chain, in this order:

1. **Bus core + BroadcastChannel transport** (`lib/src/bus/`, #547): the `BusTransport`
   interface, the encrypted envelope, account-topic derivation, and `account-delta` wired into
   the existing storage-event plumbing (`handleAccountStorageChange`). Zero new infrastructure.
2. **Signaling service + WebRTC transport** (#547, hardened in #573/#575/#577): a bespoke
   `ws` server (`signaling/`, chosen over Trystero's `ws-relay` because the per-peer relay
   fallback is not in Trystero's protocol and the bespoke server stays dependency-light), the
   DataChannel mesh transport, and the relay fallback. Deployed as the `bus-signaling`
   service in `.do/swarm-id-app.yaml` at `wss://swarm-id.snaha.net/bus`, with the URL baked
   into the UI build as `PUBLIC_BUS_SIGNALING_URL`; `pnpm dev` runs it on port 5520.
3. **Safari write enablement** (#547, #578, #635, #642, #643, #644): the widened `AuthData`
   and `sendSecretToOpener`, hydration in `handlePopupMessage`, the persisted partition
   session, roster naming for partition devices, the tombstone that survives a poll, and the
   removal of the download-only session.
4. **Bus-accelerated leases** (#547, #576, #582, #593): a slot-waiting acquire broadcasts
   `lease-request` each poll round (`onSlotWait` dep) with a fresh 8-hex `requestId`; an idle
   live holder yields via the normal idle-yield release path (`yieldForPeer`, guarded by
   `PEER_YIELD_MIN_IDLE_MS` and the in-flight upload count, under the write lock) and answers
   `lease-released`, which wakes the waiter's poll sleep (`notifySlotMaybeFree`) — handover in
   ~one bus round-trip instead of the 10 s `LEASE_REFRESH_MS` poll. The Swarm lock-SOC protocol
   is untouched as the authority and offline fallback.

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

5. **The SwarmID tab as a bus peer** (#608, #610, #631): it publishes a delta on every account
   mutation, and folds a peer's into **shared storage**
   (`ui/src/lib/stores/account-delta.ts`). The second half is what reaches a device's
   _unpartitioned_ contexts at all: they converge through `storage` events, and no storage
   event crosses a device boundary, so before this a revoke on device A never reached device
   B's proxy iframe. The fold is the one beside it for the Swarm read path — the shared LWW
   primitives, then `applyRefreshed`, whose `skipSync` is also the echo guard: a change folded
   FROM a peer is never published back at it (the proxy states the same rule as
   `source === "bus"`).

   The fold is scoped to the room's own account: a delta naming a different one is dropped,
   as it is in the proxy. The topic is derived from the account key, so this is belt and
   braces — but without it a peer holding one account's room keys could write into another
   account co-resident on the device.

   One echo does survive, bounded: with a dApp tab open, the fold's storage write reaches an
   _unpartitioned_ proxy iframe as a `storage` event, and that iframe republishes the merged
   snapshot (`schedulePublish("change")`). It terminates after that one round trip — LWW
   converges, and an identical-bytes `setItem` fires no further storage event — so it is a
   trailing confirmation of the merge, not a loop. This is also why nothing on the bus may
   stamp a fresh clock into the snapshot on every publish: it would turn that one round trip
   into a loop (see Presence).

6. **Presence** (#655): the heartbeat above, in the proxy and the SwarmID tab, feeding the
   rival set and the dev device list's Online badge.

### Not yet

- **SWIP-60 transport adapter**, once bee/bee-js release it
  ([#571](https://github.com/snaha/swarm-id/issues/571)).
- **Replay protection** ([#604](https://github.com/snaha/swarm-id/issues/604)): envelopes carry no
  nonce or timestamp, and nothing tracks what has been seen. Checked per kind, worst first:

  | kind                  | reaches the relay? | what a replay does                                                                                                                              |
  | --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | `lease-request`       | yes                | an idle holder releases its lane — two stamped Swarm writes — and re-acquires on its next upload. **The only durable cost.**                    |
  | `lease-claim`         | yes                | stands other holders down for that round; the waiter falls back to its 10 s poll                                                                |
  | `lease-released`      | yes                | wakes a waiter early: one extra read round, and #593 spends the sticky wake once                                                                |
  | `presence`            | yes                | the receiver stamps its own clock, so this only keeps a departed device in the rival set for up to the 3-minute window — one absent intent read |
  | `account-delta`       | yes                | inert: LWW on per-entity clocks, and a replayed tombstone re-applies the same tombstone                                                         |
  | `utilization-updated` | **no**             | published `localOnly`, so it never leaves the device and a relay never sees it                                                                  |

  Server-originated frames (`welcome`, `peer-joined`, `peer-left`) are not envelopes and are not in
  that table: they are the server's word, trusted from it by construction. Since #669 `peer-left`
  drops a device from the rival set, so a forged one costs an intent round its rival — but a server
  that would forge it can drop the real ones instead, which is the same denial for less work.

  **Who can replay.** The room topic and the envelope key both derive from `derivationKey`
  (`bus-context.ts`), so anything that can join the room already holds the account. The replayer is
  therefore the signaling server or a WSS MITM — a party that can already deny the fast path
  outright by dropping frames, which is cheaper and more effective than replaying one.

  **What bounds the one path that costs.** `canYieldForPeer` requires a held lane, zero in-flight
  uploads, and 3 s since the last lease activity, so a context with work ignores replays entirely;
  and a yield leaves the holder with no lane, so it cannot be made to yield again until it
  re-acquires. `answeredRequests` (32 ids, FIFO, in memory) absorbs a replay of a round this
  instance already handled — but it is empty after a reload, so a captured request replayed against
  a fresh page always falls through. That residue is exactly what a `sentAt` window would cover: the
  two guards are complementary, not redundant.

  **Why it is not built.** A `{ sentAt, message }` wrapper reintroduces clock skew into a design
  that avoided it on purpose — presence carries no timestamp precisely so there is "no timestamp to
  skew" — and the window has to be generous enough for a hidden tab's throttled timers, which still
  admits an immediate replay. Bounded nuisance, from an attacker with cheaper denial available,
  against a real new failure mode. Revisit with SWIP-60 (#571), where the transport is brokered by
  someone else and the envelope has to carry its own guarantees.

- **Gating the signaling attach** ([#581](https://github.com/snaha/swarm-id/issues/581)) — see
  Why this shape.

## Verification

Done:

- Unit (Vitest, TDD): envelope encryption/schema, "delta merged over bus ≡ delta merged from
  feed payload", lease fast-path state machine and rank election, lane-scoped utilization
  deltas, partitioned hydration and the persisted session, presence (the tracker; the proxy
  beats on join and per interval and stops on destroy; a peer's beat enters the rival set and
  ages out; the SwarmID tab beats and lists a peer). The relay tests run the real signaling
  server; WebRTC is faked.
- Playwright e2e over the real signaling server (`ui/tests/bus-propagation.test.ts`, #569): a
  genuinely partitioned proxy iframe — the demo browsed under a loopback literal while the proxy
  origin stays `localhost`, so the two are cross-site — reached by an app removal published from
  the SwarmID tab, by a **rename** made on another device (the metadata scalars fold on their
  per-field clocks since #610), and by a partitioned connect whose upload round-trips; and a
  change on one device landing in another device's stored account. The partition itself is
  asserted first, because Playwright's default chromium args turn third-party storage
  partitioning off and a suite that skips that check proves nothing.
- Presence on the local rig (2026-09-02, two browser contexts on one account): each device
  shows the other online 25 s after it joins (the first interval beat plus the dev list's 5 s
  tick) and drops it when the presence window lapses after its tab closes — 60 s when this was
  measured, three minutes since the window widened to survive a throttled background tab.
- Handover latency against the local cluster and the dev signaling server
  (`scripts/bus-handover-latency.ts`, #660; 2026-09-02, K=2, 2 s intent window). Three simulated
  devices on a two-partition batch, a fresh account per row: a free partition costs C 5.3 s (the
  floor, intent round included), a bus handover 9.0 s, a holder's idle tick 39.4 s, and a lapsed
  lock with nobody refreshing 48.5 s. The bus itself is the 1.4 s from C's call to the holder's
  `lease-released` — two stamped release writes, over the relay, since Node has no
  `RTCPeerConnection`; the remaining ~7.5 s is the ordinary cold claim. A one-off script, not
  suite coverage: it runs on demand, never on commit.
- Real Safari (iOS 18.7 / Safari 26.6, against the DO deployment, #584): ITP partitions the
  iframe, the connect popup's `window.opener` `postMessage` reaches it, the hydrated view
  builds a working stamper, a chunk uploads and reads back byte-identical, and the device id
  holds across a reload. A private window passes the same five checks, with its own device id,
  discarded when the window closes.

Not yet written:

- Lease handover with a signaling server in the live suite — sub-second with both peers live,
  timeout fallback with one peer killed. Extends
  `lib/test/live/multi-device-acquire-upload.test.ts` and
  `three-device-acquire-handoff.test.ts`, not the Playwright rig.
- Whether a dormant account's partitioned storage survives ITP's ~30-day window
  ([#664](https://github.com/snaha/swarm-id/issues/664)) — two loads in one sitting say
  nothing about it. Nothing in the bus depends on the answer now that stale devices are
  ignored rather than removed.

## Known gaps

- A revocation made while a dApp partition is **closed** is not pushed to it: the room has no
  mailbox. Since #635 the popup re-handshake is no longer what catches it either — a restored
  session reads the account's published state once instead, and ends itself on a tombstone.
  Two holes remain, both fail-open by choice (failing closed would make every offline load a
  logout): a session restored while the gateway is **unreachable** stays up, and an account
  that has **never published** — no drive, so no feed to read — has nothing to check against.
  Either way the revoke waits for the next live overlap on the bus.
- That check asks only whether the connection ENDED — a missing entry, a `revokedAt` (Remove), or
  a `disconnectedAt` newer than the connection the session came from (Disconnect). A **rotated
  signer key or moved default stamp** made while the tab was closed is not adopted on restore;
  the session comes up on the handed-over view and corrects at the next live overlap. Changes
  that arrive while it IS live are folded and re-persisted, so they survive a reload.
- **Network settings do not reach a partitioned session at all.** The Bee node and RPC URLs are
  browser-local (`swarm-id-network-settings`), not account state, so they ride the connect
  handover and nothing refreshes them: a node changed in the first-party SwarmID tab is picked up
  at the next connect. Deliberately out of scope for the bus — the settings are per-browser, and a
  peer's copy would be as meaningless as its session deadline. The proxy's `storage` listener for
  that key is skipped while partitioned, since the store it would re-read is the partition's own
  and holds nothing: loading it would silently reset the session to the public gateway and the
  default RPC ([#580](https://github.com/snaha/swarm-id/issues/580)).
- Without TURN, WebRTC will not connect across restrictive NATs; those pairs fall back to the
  signaling-server relay.
- A newcomer's join-time presence beat is dropped (its socket has no peers yet), so remote
  peers first count it at its first interval beat, up to 20 s later. Its own view of the room
  fills in the same way. The registry's 30-minute sign-in window covers the gap for the rival
  set.
- A departure is only as prompt as the socket's close. A tab closed normally produces one at
  once; a crashed peer or a dropped network waits for the server's ping cycle to reap the
  socket, and the presence window covers it until then. **The lock is not reclaimed any
  faster either way**: releasing it is a stamped SOC write the dying page cannot finish, so
  `LEASE_TTL_MS` remains the mechanism for a partition a closed tab was holding.
- The same promptness cuts the other way on a **reconnect**: a peer whose socket closes cleanly
  and comes back (a `1013` backoff, a blip the client sees before the server does) is dropped at
  once and is missing from every rival set until its rejoin beat, so a claim made in that window
  sees no rival and skips the intent round. This is a new way to flap out of the live set, which
  the three-minute window was sized to avoid; it is safe because the occupancy beacon on the
  refresh tick backstops a peer that is invisible right now (`partition-lease.ts`).
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
| A retained-message mailbox on the signaling server                     | Considered in the original design so a change could reach a closed partition; never built. The restore-time revocation read (#635) covers the case that mattered.            |
