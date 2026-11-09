# Decisions

Architecture and product decisions, newest first. One entry per decision: the
context in a line or two, the decision, and why. Append only; a reversed
decision gets a new entry that names the old one. Code comments describe the
present and may point at an issue or PR; the reasons live here.

A PR that makes or changes a decision adds the entry in the same PR.

## 2026-09-21 Stamper-mode uploads honour the caller's `deferred`

**Context.** Every data and chunk upload in stamper mode forced
`deferred: false`, so a caller's `true` was silently dropped.

**Decision.** Stamper mode passes the caller's `deferred` through. (#784)

**Why.** Setting the flag from `getNodeInfo()` is the documented remedy for a
node that needs it, and dropping it made the upload time out anyway.

## 2026-09-17 A per-call timeout bounds the whole round trip

**Context.** `requestOptions.timeout` reached only the Bee request inside the
iframe, while the client's own round-trip timer kept the constructor default.

**Decision.** The per-call value bounds the client's round-trip timer as well
as the Bee request. (#775)

**Why.** A per-call value above the default still rejected at the default,
with the same message the caller was trying to escape.

## 2026-09-11 Balances are read through the chain's own endpoint

**Context.** #534 read balances through the wallet wherever it was on the
selected chain, for the figures the wallet itself shows.

**Decision.** Balances are read through the chain's own endpoint, never the
wallet. Reverses #534.

**Why.** Over WalletConnect every read is a relay round trip to the user's
phone, and a session left holding responses nobody is waiting for redelivers
them for the rest of its life.

## 2026-09-11 `AlreadyKnown` from a node is a success

**Context.** `AlreadyKnown` took the write retry's rethrow branch.

**Decision.** It counts as a successful broadcast: the node has the
transaction.

**Why.** Once a send reached any mempool, every resend of those bytes failed,
the user's Try again included, because the nonce and the payload do not change
on their own.

## 2026-09-04 One saved session per dApp origin

**Context.** Storage is partitioned by iframe origin and top-level site, and a
site ignores the subdomain, so two dApps under one site share a store. The
saved session lived under one fixed key.

**Decision.** The handover is saved under
`partitionSessionStorageKey(parentOrigin)`. (#671)

**Why.** The second dApp to connect overwrote the first one's session, and
both needed the popup again on every reload.

## 2026-09-04 A refused handover ends the connect attempt

**Context.** A payload that failed the schema left the proxy's spinner running
while the popup, which cannot tell it was refused, said "Connected!". It was
also rejected further on as coming from an unauthorized origin.

**Decision.** A refused handover ends the attempt it belongs to, and the log
names the schema failure. (#587, #678)

**Why.** A refused handover is the ordinary way a version-skewed identity
deployment fails, and it must not read as an origin bug. Only closing the
popup cleared the spinner, which the user had no reason to do.

## 2026-09-04 Lease lanes are per (batch, partition)

**Context.** One partition-lock namespace was shared across all of an account's
batches.

**Decision.** Lock, intent and occupancy addresses are derived per (batch,
partition), and a `lease-request` names its batch. (#589)

**Why.** A holder on one batch and a waiter on another contend for nothing.

## 2026-09-04 A connected app's membership merges on the fields that state it

**Context.** One clock bumped by every write ranked the entry, so a drive
picked on a stale copy outranked a revoke and restored the credential it had
cleared. A dApp-initiated Disconnect wrote `lastConnectedAt: 0`.

**Decision.** Membership merges on
`max(revokedAt, disconnectedAt, lastConnectedAt)`, and a Disconnect sets
`disconnectedAt`. (#681, #682)

**Why.** A zero loses every merge, so the entry's old timestamp came back on
the next fold and the Disconnect never reached a peer.

## 2026-09-03 Only a genuine sign-in re-activates a device

**Context.** `mergeDevices` stamped our own entry on every poll, and the
announce path read a tombstoned self as "not yet announced".

**Decision.** A poll touches neither `removedAt` nor `lastSignedInAt`.
Re-activation happens at `reactivateThisDevice`, the one seam that can tell a
user unlocking their account from a timer. A tombstoned self stands down.
(#337, #611, #652)

**Why.** Clearing the tombstone undid every removal on the next round, and
republishing without it resurrected the device on every peer. Stamping the
field made every fold a byte change, which a proxy holding a partition
answered with a bus delta and a stamped feed write.

## 2026-09-03 Device names and app grants have clocks of their own

**Context.** Three dApps on one Safari are three partition devices, and a
corrected label moves neither `lastSignedInAt` nor `removedAt`.

**Decision.** A device's name merges on its own `nameUpdatedAt`, and a
connected app's grant field by field on its own clocks. (#643, #663)

**Why.** Without a clock a corrected row ties with every stale copy of itself
and loses, so every other context keeps the stale name forever.

## 2026-09-01 A partitioned session survives a reload

**Context.** The handed-over session lived only in memory, so every page load
re-ran the connect popup. On Safari, where partitioned is the ordinary mode, a
plain reload was a logout.

**Decision.** The handover is persisted in the partition's own store, under
the same 30-day deadline as the unpartitioned path. A restored session comes
up at once and checks the account's Swarm state in the background. (#635)

**Why.** The deadline cannot see a revoke made while the tab was closed, and
persisting removes the re-handshake that caught it. Trusting local storage
first and learning of a remote revoke after is what the unpartitioned path
already does.

## 2026-09-01 A session requires the account projection

**Context.** A payload with no account built a "download-only" session with no
stamps and no `derivationKey`.

**Decision.** `AuthDataSchema` requires the projection, so such a payload is
refused. (#642)

**Why.** Without a `derivationKey` a session derives no bus topic, joins no
room and can never be told it was revoked. No session beats a session nothing
can reach.

## 2026-09-01 An endpoint that cannot be identified gets no bridged rail

**Context.** A genesis probe that blipped was routed like a proven dev chain.

**Decision.** "Not proven mainnet" is not "proven dev": an unidentified
endpoint gets no bridged rail.

**Why.** A wallet pointed at real Gnosis was offered a local rail that takes a
deposit on a chain the destination has never heard of.

## 2026-08-31 The auth transport follows the storage mode

**Context.** `connect()` picked its transport by user agent, so a partitioned
Chromium was put on the storage-event path while only WebKit got the handover.

**Decision.** The iframe's storage probe decides, and `proxyReady` reports it.
(#613, #630)

**Why.** A partitioned iframe can only be reached by the popup it opened
itself, and no user agent says which mode an iframe is in.

## 2026-08-31 A handover carries only what the grant names

**Context.** The partitioned handover shipped every stamp with its signer key.

**Decision.** The handover is limited to the stamps this app's grant names.
(#578)

**Why.** The session runs in a context embedded by an arbitrary dApp page. It
can only spend the drives it was granted, so the other signer keys are pure
exposure.

## 2026-08-31 The payment method is chosen before any balance read

**Context.** The funding seam was the only place to choose, and it is raised
only when the owner address is short.

**Decision.** The chooser precedes the balance read. (#619)

**Why.** An account holding funds from an earlier attempt was committed to the
built-in engine with no way to say otherwise, and a purchase that could not
reach the chain failed before the question was put.

## 2026-08-27 The signaling room topic travels in the `join` frame

**Context.** The topic travelled as `/?topic=<hex>`.

**Decision.** It goes in the first frame, and the URL form is refused. (#577)

**Why.** The topic is the room capability, and query strings are recorded by
every ingress and proxy access log.

## 2026-08-27 A device registry merge is saved when any field moves

**Context.** The refresh persisted a merge only when the list got longer.

**Decision.** A merge that moved any field is saved, `lastSignedInAt` and
tombstones included.

**Why.** `activeDeviceIds` prunes the rival set on those fields, so a peer the
roster shows as live could age out of the stored copy, miss the intent round
and dual-acquire.

## 2026-08-26 Bus channels are per account

**Context.** The local channel was one origin-wide constant, harmless while the
only traffic was batch-scoped counters.

**Decision.** The topic comes from `deriveBusContext`, the same value the
signaling transport uses as its room.

**Why.** `account-delta` carries `postageStamps[].signerKey`, so co-resident
accounts must not share an unencrypted channel.

## 2026-08-26 A `lease-request` ranks the holders

**Context.** One waiter's `lease-request` made every idle holder yield.

**Decision.** Every holder takes a rank from the request id, and holders
further down the order stand down on a claim. The schema drops an id that does
not parse to a rank. (#576)

**Why.** An id that parses to NaN or a negative puts every holder at rank 0,
which is the same stampede, silently.

## 2026-07-13 Plain Merkle trees use 128-ref intermediate chunks

**Context.** Plain uploads built intermediate chunks with a 64-ref fanout.

**Decision.** The plain Merkle layout matches what a stock node builds, 128
refs per intermediate chunk. (#417)

**Why.** Bee could not join trees built with a 64-ref fanout.

## 2026-07-04 Sync is wired app-wide in the root layout

**Context.** Publish and fold were wired only in `/dev`.

**Decision.** The root layout owns the publish hook. (#389)

**Why.** The shipping app never synced, and a partitioned dApp iframe learns
about a revoke no other way.

## 2026-07-03 The state pointer is a reserved-slot SOC

**Context.** The partition's state pointer was an epoch feed entry in a data
slot.

**Decision.** It is a reserved-slot SOC that overstamps the partition's
reserved slot, like the counter chunks.

**Why.** It consumes no data slot, so the snapshot has nothing to compensate
for.

## 2026-06-29 One kind of account, one nested document

**Context.** Accounts had distinct types (passkey, ethereum, agent), with flat
identity, app and stamp stores joined by pointers.

**Decision.** There is one BIP-39 seed account that owns its connected apps and
postage stamps inline. Access methods live in the device-local vault. (#377)

**Why.** The types were only different ways of protecting the seed.

## 2026-06-26 Device discovery is an append-only roster

**Context.** Devices shared one mutable registry document and one snapshot.

**Decision.** An append-only roster handles discovery, and each device
publishes its own state feed, folded on read.

**Why.** On a high-latency or caching gateway, read-merge-overwrite dropped a
peer's just-written entry.

## 2026-06-16 A release sentinel is generation-fenced

**Context.** A stale release could write a sentinel over a successor's claim.

**Decision.** The sentinel carries the generation of the claim it releases.
(#349)

**Why.** A fresh-generation sentinel reads back as a higher generation, which
is a false lost race and a spurious read-only session.

## 2026-06-12 The theme key is `swarm-id-theme`

**Context.** Earlier deployments auto-persisted the OS-resolved theme under
`swarm-ui-theme` on every first visit.

**Decision.** The preference lives under `swarm-id-theme`, and everyone starts
on `auto`.

**Why.** The old key's value cannot be told apart from an explicit user choice.
