# Account State — Phase 3 Design: per-device snapshot-feed CRDT

Status: **settled — ready to implement 3a.** All §9 decisions resolved. Builds on Phase 0–2 + Phase 1
(#337, PR #372). Design rationale and
the phased north star this expands live in
[`Account-State-Refactor-Plan.md`](./Account-State-Refactor-Plan.md) (§6–§7); the phase-by-phase record
of what lands goes in [`Account-State-Phase3-Implementation-Log.md`](./Account-State-Phase3-Implementation-Log.md).

> **Pre-production: no migration.** The current version is not deployed. Phase 3 is a hard cutover —
> the new topics carry a fresh version tag and the old shared-snapshot path is removed, not dual-read.

## 1. Why

Today every device writes the **whole account snapshot** to **one shared epoch feed**
(`swarm-id-backup-v1:account:{accountId}`, `lib/src/sync/publish-account-state.ts`). Concurrent writers
write the same SOC address; Bee is last-writer-wins, so the publisher does a
**fetch → merge → re-upload → `verifyWon` → optimistic retry (×3)** dance to avoid stomping a peer
(`publish-account-state.ts:155-352`). This is concern **A** (account-state convergence). It is:

- **bandwidth-heavy** — O(full state) re-uploaded on every change, and
- **contention-prone** — a single shared feed serialised by retries, amplified by the partition guard
  window and cross-gateway 404s (the "parked partition-acquire latency" in the impl log).

Phase 3 removes concern A's shared write: **each device writes only its own per-device feed** (holding
that device's latest full view), and convergence moves from write time to **read/fold** time.
Cross-device write contention on account state drops to ~zero. Concern **B** (postage-batch slot
partitioning) is unchanged and still required.

## 1a. Assumptions (multi-device)

These shape the whole multi-device scheme and apply to **both** concern A (account-state convergence,
this doc) and concern B (postage-batch partitioning, `Postage-Batch-Partitioning.md`).

1. **Cooperative, non-malicious devices.** Every device belongs to one user and holds the account key
   (`derivationKey`), so any device can sign any of the account's feeds (the lock SOCs, the per-device
   state feeds, the roster). The scheme guarantees **convergence**, not Byzantine fault tolerance: a peer
   that holds the key but ignores the cooperative protocol can corrupt state, and defending against that
   is explicitly out of scope (the partition lock makes the same call —
   `lib/src/sync/partition-lock.test.ts` "assumes cooperative non-malicious devices … out of the
   iteration-2 threat model"). This is what lets feeds be **topic-namespaced under one shared owner**
   rather than needing per-device signing keys (§2).

2. **Loosely-synchronized clocks (within ~seconds).** Convergence and exclusivity both lean on
   wall-clock timestamps: the LWW merge (`updatedAt` / `revokedAt` / `deletedAt` / `removedAt`, and the
   per-field scalar `at`) and the partition lease TTLs (`LEASE_TTL_MS = 30 s`) / rotating intent epoch
   buckets. Devices must agree on the time to within a few seconds. Large skew can mis-order an LWW
   resolution or mis-judge a lease's liveness; the lock tolerates **bounded** skew (see the clock-skew
   test in `partition-lock.test.ts`) but not arbitrary drift.

3. **Adding/removing a device is far rarer than using existing ones.** Membership changes (a new
   sign-in, a removal/sign-out) are infrequent compared with routine account-state writes (connecting an
   app, buying/deleting a stamp). The design leans on this:
   - the **device roster** (§2.1) is an append-only feed touched **only** on a membership change — the
     hot path (apps/stamps) never reads or writes it;
   - the per-device **state feeds** carry all the high-frequency data and are individually robust;
   - so the residual ~50 s gateway negative-cache latency for a **fresh** roster entry is acceptable — a
     newly-added device becomes discoverable within ~a minute, while already-known devices are immediate.

## 2. Architecture: three layers

```
                    ┌─────────────────────────── per account ───────────────────────────┐
  discovery   ─────▶│  Device-registry feed   H("swarm-id-devreg-v1" ‖ accountId)         │  shared, RARE writes
                    │     { deviceId, name, createdAt, lastSignedInAt, removedAt }[]       │
                    ├─────────────────────────────────────────────────────────────────────┤
  hot path    ─────▶│  Device-state feed (A)  H("swarm-id-devstate-v1" ‖ accountId ‖ A)    │  per-device, FREQUENT
                    │  Device-state feed (B)  H("swarm-id-devstate-v1" ‖ accountId ‖ B)    │  writes, NO contention
                    │     epoch feed, latest-pointer = that device's full current view     │
                    └─────────────────────────────────────────────────────────────────────┘
  read        ─────▶  fold = read registry → for each device fetch its LATEST view →
                       merge views across devices (Phase 1 rules) → applyRefreshed
```

All feeds share **one owner** — the account backup key,
`deriveSecret(deriveSwarmEncryptionKey(account.derivationKey), "backup-key")` (the same owner used today
for the shared snapshot feed and the partition lock SOCs). Feeds are distinguished by **topic**, not by
owner. This is safe: all devices are the same trusting user, all already hold `account.derivationKey`.
No per-device signing keys.

### 2.1 Device-registry feed (discovery)

The bootstrap problem: to fold per-device logs you must know the set of `deviceId`s, but today that set
lives only in the shared snapshot's `metadata.devices` (read via `restoreAccountFromSwarm` /
`refreshAccountFromSwarm` → `snapshot.metadata.devices`, then `mergeDevicesList`). Removing the shared
snapshot removes discovery.

Replacement: a dedicated **device-registry feed**, `topic = H("swarm-id-devreg-v1" ‖ accountId)`, owner
as above. Payload = the device set (the `Device[]` shape: `deviceId, name, createdAt, lastSignedInAt,
removedAt`). It is written **only on membership change** — a device's first sign-in (announce self) and
on remove/sign-out — so it is a low-frequency feed; the existing single-feed merge tolerates it without
the heavy arbitration the hot path needed. Merge reuses **`mergeDevicesList`** (Phase 1 — `removedAt`
tombstones already converge). It can be an epoch feed (latest-pointer is all we need here).

Complementary signal (already present, not a replacement): partition **lock SOCs** carry
`holderDeviceId`, so reading the K lock SOCs reveals currently-active writers. Useful for "who is live
now", but incomplete (≤K holders, misses read-only/departed devices), so the registry feed remains the
authoritative membership source.

### 2.2 Per-device snapshot feeds (the hot path)

> **Model choice.** We use a per-device **snapshot** feed (each device publishes its full current view
> to its own feed), not an append-only op-log. This is the model `swarm-collaborative-docs` uses for Yjs
> (§Related work): it reuses today's epoch feed + snapshot serialization + Phase 1 merge almost verbatim,
> is **self-compacting** (only the latest entry matters → no compaction phase), and is the minimal change
> from today. The op-log/delta variant is kept as an optional future bandwidth optimization (§5).

`topic = H("swarm-id-devstate-v1" ‖ accountId ‖ deviceId)`, the existing **epoch feed**
(`BasicEpochUpdater`/`AsyncEpochFinder`, latest-pointer). Each device writes its **full current account
view** to its **own** feed using the existing `serializeAccountState` (the payload references a chunked
blob exactly as the shared snapshot does today — no new wire format):

```ts
DeviceStateSnapshot = {           // ≈ today's AccountStateSnapshot, minus metadata.devices
  connectedApps:  ConnectedApp[]  // each carries updatedAt / revokedAt (Phase 1)
  postageStamps:  PostageStamp[]  // each carries createdAt / deletedAt (Phase 1)
  // scalars fold by PER-FIELD LWW (each carries its own `at` — see §9 decision 3):
  accountName:                { value: string, at: number }
  defaultPostageStampBatchID: { value: string | undefined, at: number }
  settings:                   { value: AccountSettings, at: number }
}
```

It is the device's **full merged view** (its own edits folded with whatever it has read from peers), à
la a Yjs peer writing its full state — so any single device's feed can reconstruct everything it has
seen, and the fold is idempotent. A device re-writes its view only on a **local mutation**, not on every
read/fold, so write amplification is bounded. Device membership (`deviceId, name, lastSignedInAt,
removedAt`) lives in the **registry** (§2.1), not here.

**Exclusivity.** A device writes **only its own** feed. There is no shared SOC address across devices,
so **`publishAccountState`'s merge-read-rewrite + `verifyWon` retry loop disappears** — a write is just
"upload my snapshot blob, advance my epoch feed". Per-device writes still ride the partition lease (§3),
so two devices' feeds are slot-disjoint.

### 2.3 Fold-on-read

```
fold(account):
  registry = readDeviceRegistry(accountId)                       # Device[]  (discovery)
  views    = []
  for d in registry.devices where !d.removedAt:
     views.push( readLatestDeviceState(accountId, d.deviceId) )  # ONE epoch-finder lookup per device
  merged = views.reduce(mergeViews)                              # mergeConnectedApps / mergePostageStamps (Phase 1)
  return { devices: registry.devices, ...merged }                # same shape applyRefreshed() already consumes
```

- Cross-device merge is **exactly the Phase 1 primitives** (`mergeConnectedApps`, `mergePostageStamps`;
  `mergeDevicesList` for the registry) — recency = `max(tombstone, activity)`. Convergence and deletion
  semantics are therefore **identical to Phase 1 by construction** (see §6 differential test).
- Scalar account fields fold by **per-field** LWW (each scalar carries its own `at`), so a concurrent
  name change on A and default-stamp change on B both survive (§9 decision 3).
- **Cost** = K epoch-finder lookups (one per device, ~log each) + blob fetches. No `lastIndex` state, no
  compaction — each feed is a single latest-pointer.

The output `{ devices, connectedApps, postageStamps, settings, defaultPostageStampBatchID, accountName }`
is what `accountsStore.applyRefreshed(...)` (`swarm-ui/.../accounts.svelte.ts`) and the proxy's
`buildConnectionInfo` already consume. **The plug point is unchanged.**

## 3. Partition interaction (concern B stays)

Per-device snapshot writes still consume bucket slots on the shared **mutable** postage batch, so they
still route through `BatchWriteCoordinator.withWrite` (cross-tab Web Lock + partition lease;
`lib/src/sync/batch-write-coordinator.ts`). The lease guarantees **two devices never hold the same
partition at once**, so two devices writing their own feeds are automatically slot-disjoint — the
"device → partition → own feed" alignment §6.5/§7 predicted, achieved with **no stable device→index
binding**: a device writes under whatever partition it currently holds. The registry feed and
device-state feeds are written under the held partition just like the shared snapshot is today.

### 3.1 How a device with no partition acquires one (the intent mechanism)

This is concern B's existing machinery, inherited unchanged; Phase 3 doesn't alter it. A device that
holds no partition cannot write its own feed until it wins a slot:

1. **Pick a target partition** — `pickFreeOrExpired` (`partition-lease.ts:378`) scans from the device's
   deterministic `deviceHomePartition(deviceId, K)` offset and returns the first partition with no live
   holder. If all are live-and-foreign-held → `acquire()` returns `{ isReadOnly: true }`
   (`partition-lease.ts:430`). A read-only device **folds/reads fully**; it just can't write.
2. **Signal intent** — before claiming a free/expired partition `p`, it runs an **intent round**
   (`partition-intent.ts`): it writes an **intent SOC**,
   `identifier = keccak256("swarm-id-partition-intent-v1:{p}:{deviceId}:{epochBucket}")`, payload
   `{ deviceId, generation }`. The address **rotates every `INTENT_EPOCH_MS = 30 s`** (fresh per round),
   and it polls rivals over `INTENT_GUARD_WINDOW_MS = 12 s`; the highest `generation`/tiebreaker wins and
   claims `p`'s lock SOC.
3. **Which slot/index** — the intent SOC is forced into the **reserved slot equal to the partition index
   `p`** it contends (`stamper.reserveIntentSocSlot(address, p)`, `batch-utilization.ts:1418`), in
   whatever bucket its rotating address maps to. Reserved slots are `[0, K)` (one per partition, slot
   index = partition; `Postage-Batch-Partitioning.md` §2–3): mutable-overwritten, **never a data slot**,
   never counting toward utilisation. So the "I want partition `p`" signal lives in the same reserved
   lane (slot `p`) as `p`'s lock SOC.
4. **The wait** — a read-only device polls `acquireWithSlotWait` (`batch-write-coordinator.ts:544`) every
   `LEASE_REFRESH_MS = 10 s`. It only wins when a holder **idle-yields** (`IDLE_YIELD_MS = 30 s`) or its
   **lease lapses** (`LEASE_TTL_MS = 30 s`); else it eventually throws `PartitionContendedError` and the
   write is deferred.

**Inherited ceiling:** `PARTITION_COUNT = 2` (`lib/src/utils/batch-utilization.ts:76`) ⇒ at most **2
concurrent writers**. A 3rd+ device is a read-only extra (folds/reads fine, writes only once it wins a
slot via the above). Raising K is a separate lever, out of scope for Phase 3.

## 4. Optional future optimization: per-device op-log (delta) feeds

The snapshot-feed model re-uploads a device's **full current view** on every change. For our small
account state that is cheap and contention-free, so **no compaction is needed** — each feed is a single
latest-pointer that self-compacts. If per-change bandwidth ever matters (large state), the snapshot feed
can be swapped for a per-device **op-log**: a sequential feed of small deltas
(`app.upsert`/`stamp.delete`/…), folded with a cached `lastIndex` per device, plus periodic per-device
checkpoints (Automerge "snapshot + incremental chunks"). This is a drop-in replacement for §2.2 behind
the same fold/`applyRefreshed` boundary — deferred until measured need, not part of 3a.

## 5. Deletes (sub-phase 3c, optional)

3a keeps the **Phase 1 LWW tombstones** (`deletedAt`/`removedAt`/`revokedAt`): simple, already proven,
already converge. The rigorous upgrade (§6.3 of the plan) — **OR-Set** (observed-remove, add-wins via
per-add dots) and **version vectors** with **causal-stability tombstone GC** — is the optional tail 3c,
warranted only once tombstone accretion in the full-view snapshots becomes a measured problem (a dot is
naturally `deviceId × a per-device counter`).

## 6. Verification

- **Unit (lib):**
  - device-state snapshot encode/decode round-trip (reuses `serializeAccountState`).
  - **Differential fold equivalence** — for a generated set of per-device views, `fold(K device states)`
    ≡ the Phase 0–2 snapshot merge of the same data. This _locks Phase 3 to today's observable
    behaviour_ and is the key correctness gate.
  - registry merge — reuses the Phase 1 `mergeDevicesList` tests.
- **Integration (real Swarm):** adapt the proven `scripts/deletion-sync-test.ts` harness (two devices,
  one feed each). Assert: device B folds device A's latest view and converges; deletions propagate;
  resurrection works; and **the shared `swarm-id-backup-v1` feed is never written** (the §7 invariant).
  Runs on the local bee-compose cluster and the public gateway (both validated during Phase 1).
- Each sub-phase leaves `pnpm check:all` green.

## 7. Sub-phase plan

| Sub-phase      | Scope                                                                                                                                                                                                                                             | Exit                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **3a**         | Device-registry feed + per-device **snapshot** feed write/fold; cut `createSyncAccount`/refresh/restore/proxy over to it; **delete** the shared-snapshot publish + `verifyWon` loop. Keep Phase 1 tombstones. Hard cutover, new versioned topics. | `check:all` green; differential fold test passes; two-device gateway run converges with no shared-feed write. |
| **3c** _(opt)_ | OR-Set / version-vector + causal-stability tombstone GC.                                                                                                                                                                                          | Tombstones GC'd once causally stable; differential test extended.                                             |
| _(opt, later)_ | Op-log/delta feeds (§4) if per-change bandwidth is ever measured to matter.                                                                                                                                                                       | Same fold boundary; bounded per-device log.                                                                   |

## 8. Critical files

**New (lib):**

- `lib/src/sync/device-state.ts` — per-device snapshot feed read/write (`writeDeviceState`,
  `readLatestDeviceState`) + `foldAccount(views, registry)`.
- `lib/src/sync/device-registry.ts` — registry feed read/write + merge (wraps `mergeDevicesList`).

**Reuse:**

- `lib/src/proxy/feeds/epochs/*` (epoch feed — latest-pointer, for both the device-state and registry
  feeds).
- `lib/src/sync/serialization.ts` (`serializeAccountState`/`deserializeAccountState`) +
  `account-state-snapshot.ts` for the device-state payload.
- `lib/src/sync/merge-snapshot.ts` — `mergeConnectedApps`/`mergePostageStamps`/`mergeDevicesList` for the
  fold (Phase 1).
- `lib/src/proxy/upload.ts` (`uploadData`, `UploadTarget`), `download-data.ts`,
  `lib/src/utils/key-derivation.ts` (owner/encKey/topic).

**Modify:**

- `lib/src/sync/sync-account.ts` — write the device's own state snapshot to its own feed via the
  coordinator instead of calling the shared `publishAccountState`.
- `lib/src/sync/restore-account.ts` + `swarm-ui/src/lib/utils/refresh-account-from-swarm.ts` — fold the K
  device-state feeds (+ registry) instead of fetching the one shared snapshot; same `applyRefreshed`
  output.
- `lib/src/swarm-id-proxy.ts` — registry-based discovery (`refreshDeviceRegistryFromSwarm`,
  `knownDeviceIdsForAccount`); publish-on-acquire → write own device-state + announce in the registry.

**Retire:** the shared-feed merge/`verifyWon` core of `lib/src/sync/publish-account-state.ts`
(`mergeSnapshotWithRemote` / `snapshotContainsContribution` keep their unit value for the differential
test but leave the write path).

## 9. Resolved decisions

1. **Discovery = dedicated device-registry feed.** Complete (all devices, including read-only and
   departed) and robust, with external precedent (the `swarm-collaborative-docs` members feed, §11). The
   partition lock SOCs stay a complementary "who is live now" signal, **not** the membership source.
2. **Device-state payload = full merged view** (not own-contribution-only). Each device writes its entire
   current account view, à la a Yjs peer. Any single feed reconstructs everything that device has seen
   (redundancy), the fold is idempotent, and it reuses `serializeAccountState` with **no per-entity
   ownership tracking**. A device re-writes only on a **local mutation**, so write amplification is
   bounded; convergence still holds via the fold even if a device never re-writes (its peers' feeds carry
   the change).
3. **Scalars use per-field LWW clocks.** `accountName`, `defaultPostageStampBatchID`, and `settings` each
   carry their own `at` and fold independently (max `at` wins per field) — **not** one account-wide
   `lastModified`. This prevents a concurrent change to a _different_ scalar on another device from being
   dropped wholesale. It is the same LWW pattern the collections use, applied to three tiny "scalar
   entities". (Per-field is cheap — three timestamps — and the concurrent name-vs-default-stamp case is
   realistic, so the correctness is worth it.)
4. **>2 devices = read-only extras; `K=2` accepted.** Inherited from concern B (§3.1). A read-only device
   folds/reads fully and writes once it wins a slot via the intent mechanism. Raising `PARTITION_COUNT`
   (or a writer-rotation scheme) is a separate, out-of-scope lever.
5. **Tombstone GC deferred to 3c, triggered by measurement.** 3a keeps the Phase 1 LWW tombstones.
   Full-view snapshots carry tombstones in every device's feed (K× copies), but for a single user's
   account (a handful of apps/stamps over its lifetime) growth is slow. Adopt OR-Set / version-vector +
   causal-stability GC (3c) only once accretion is measured to matter.

## 10. References

- [`Account-State-Refactor-Plan.md`](./Account-State-Refactor-Plan.md) §6 (design-space research), §7
  (phased direction — Phase 3 is the north star this expands), §6.5 (Swarm primitive mapping).
- [`Account-State-Refactor-Implementation-Log.md`](./Account-State-Refactor-Implementation-Log.md) —
  Phase 0/1/2 record; Phase 1 (#337) tombstones this fold reuses.
- Psaras & Sanjuán, _Merkle-CRDTs_; Almeida et al., _Delta-State CRDTs_; Shapiro et al., _OR-Set_;
  Automerge 2.0 incremental format (all linked in the refactor plan §10).

## 11. Related work — `swarm-collaborative-docs`

[`Solar-Punk-Ltd/swarm-collaborative-docs`](https://github.com/Solar-Punk-Ltd/swarm-collaborative-docs)
(collaborative editing — **Yjs** CRDT over Swarm) independently arrives at the same shape and motivated
the snapshot-feed model above.

- **Validates:** _per-user (per-device) Swarm feeds_ — each peer writes to its **own** feed (no shared
  write contention); and a **shared `<topic>_members` consensus feed** for peer discovery — direct
  precedent for our **device-registry feed** (§2.1) over lock-SOC discovery.
- **What we adopt:** each peer's feed holds its **full latest snapshot** (not an op-log). Late joiners
  read the members list, fetch each peer's latest snapshot, and merge. This is exactly §2.2/§2.3.
- **Where we differ:**
  - _Structured LWW state, not free-form text_ → we use the Phase 1 merge primitives, **not** a general
    CRDT engine (Yjs/Automerge). Our entities (apps/stamps/devices) converge under simple
    LWW + tombstones; a text CRDT would be over-engineering.
  - _No real-time transport._ They add a pluggable WebRTC/pubsub/Waku delta channel for low-latency
    co-editing + cursor awareness. Account state changes are infrequent and non-collaborative, so Swarm
    feeds alone suffice; presence is already covered by the partition lock SOCs (and could use Bee GSOC
    later) — out of scope here.
  - _Postage._ Same model: one batch covers all of a session's writes.
