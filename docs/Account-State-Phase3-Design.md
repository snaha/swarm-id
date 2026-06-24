# Account State — Phase 3 Design: per-device op-log CRDT

Status: **proposal / for review.** Builds on Phase 0–2 + Phase 1 (#337, PR #372). Design rationale and
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

Phase 3 removes concern A's shared write: **each device writes only its own append-only change-log
feed**, and convergence moves from write time to **read/fold** time. Cross-device write contention on
account state drops to ~zero. Concern **B** (postage-batch slot partitioning) is unchanged and still
required.

## 2. Architecture: three layers

```
                    ┌─────────────────────────── per account ───────────────────────────┐
  discovery   ─────▶│  Device-registry feed   H("swarm-id-devreg-v1" ‖ accountId)         │  shared, RARE writes
                    │     { deviceId, name, createdAt, lastSignedInAt, removedAt }[]       │
                    ├─────────────────────────────────────────────────────────────────────┤
  hot path    ─────▶│  Op-log feed (device A)  H("swarm-id-oplog-v1" ‖ accountId ‖ A)      │  per-device, FREQUENT
                    │  Op-log feed (device B)  H("swarm-id-oplog-v1" ‖ accountId ‖ B)      │  writes, NO contention
                    │     seq 0,1,2,…  each entry = delta of ops                           │
                    └─────────────────────────────────────────────────────────────────────┘
  read        ─────▶  fold = read registry → for each device read its log from lastIndex →
                       reconstruct per-device collections → merge across devices (Phase 1 rules)
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

### 2.2 Op-log feeds (the hot path)

`topic = H("swarm-id-oplog-v1" ‖ accountId ‖ deviceId)`, a **sequential** feed
(`lib/src/proxy/feeds/sequence/` — `BasicSequentialUpdater`, identifier = `keccak256(topic ‖ indexBE)`,
index 0,1,2…). Sequential (not epoch) because we need "read all entries since X", not "find latest".

Each feed entry is a **delta** — a batch of ops accumulated since the last write:

```ts
LogEntry = {
  v: 1
  deviceId: string          // author (redundant with topic, but self-describing)
  seq: number               // feed index
  ts: number                // wall-clock ms of this batch
  ops: Op[]
}

Op =
  | { t: "app.upsert",   app: ConnectedApp }                       // carries updatedAt
  | { t: "app.revoke",   appUrl: string, revokedAt, updatedAt }
  | { t: "stamp.upsert", stamp: PostageStamp }                     // carries createdAt
  | { t: "stamp.delete", batchID: string, deletedAt }
  | { t: "settings.set", settings: AccountSettings }
  | { t: "account.setDefaultStamp", batchID: string | undefined, at }
  | { t: "account.setName", name: string, at }
```

Ops carry the **same LWW/tombstone clocks as Phase 1** (`updatedAt`, `revokedAt`, `deletedAt`), so the
fold can reuse the Phase 1 merge verbatim (§2.3). Device metadata (name/lastSignedInAt/removedAt) lives
in the registry, **not** the op-log.

**Size.** A delta of a handful of ops is far under the 4 KB SOC payload limit
(`lib/src/chunk/constants.ts:MAX_PAYLOAD_SIZE = 4096`) → encoded inline in the SOC payload. If an entry
would exceed the limit (e.g. a large initial state), encode the ops as a chunked blob via the existing
`uploadData` and store the blob reference as the entry payload (mirrors how the snapshot feed references
its blob today). 3a may simply cap/inline and add blob-spill only if needed.

**Exclusivity.** A device appends **only to its own** feed at the next index. There is no shared SOC
address across devices, so **the merge-read-rewrite + `verifyWon` retry loop disappears.** A write is:
encode delta → `BasicSequentialUpdater.update(payload, stamper, encKey)` at `nextIndex`.

### 2.3 Fold-on-read

```
fold(account):
  registry  = readDeviceRegistry(accountId)              # Device[]  (discovery)
  perDevice = []
  for d in registry.devices where !d.removedAt:
     entries = readOpLogFrom(accountId, d.deviceId, lastIndex[d.deviceId])   # forward until 404/gap
     lastIndex[d.deviceId] = highest index read                              # cache for next time
     perDevice.push( replayOps(entries) )                # → { connectedApps, postageStamps, settings, default, name }
  merged = perDevice.reduce(mergeCollections)            # mergeConnectedApps / mergePostageStamps (Phase 1)
  return { devices: registry.devices, ...merged }        # same shape applyRefreshed() already consumes
```

- `replayOps` reduces one device's ops to its latest contribution per entity (LWW per key within the
  device), yielding partial collections.
- Cross-device merge is **exactly the Phase 1 primitives** (`mergeConnectedApps`, `mergePostageStamps`,
  and `mergeDevicesList` for the registry) — recency = `max(tombstone, activity)`. Convergence and
  deletion semantics are therefore identical to Phase 1 by construction (see §6 differential test).
- Scalar account fields (name, default stamp, settings) fold by LWW on their `at` clock across devices.
- **Steady-state cost** is O(new ops) because `lastIndex[deviceId]` is cached locally; cold start reads
  each device's whole log (bounded by compaction, §4 / 3b).

The output shape is `{ devices, connectedApps, postageStamps, settings, defaultPostageStampBatchID,
accountName }` — what `accountsStore.applyRefreshed(...)` (`swarm-ui/.../accounts.svelte.ts`) and the
proxy's `buildConnectionInfo` already consume. **The plug point is unchanged.**

## 3. Partition interaction (concern B stays)

Per-device op-log writes still consume bucket slots on the shared **mutable** postage batch, so they
still route through `BatchWriteCoordinator.withWrite` (cross-tab Web Lock + partition lease;
`lib/src/sync/batch-write-coordinator.ts`). The lease guarantees **two devices never hold the same
partition at once**, so two devices writing their own feeds are automatically slot-disjoint — the
"device → partition → own feed" alignment §6.5/§7 predicted, achieved with **no stable device→index
binding**: a device writes under whatever partition it currently holds.

**Inherited ceiling:** `PARTITION_COUNT = 2` (`lib/src/utils/batch-utilization.ts:76`) ⇒ at most **2
concurrent writers**. A 3rd+ device is a read-only extra: it can **fold/read** fully, but cannot append
to its own log until it gets a partition slot (today's behaviour). Raising K (more concurrent writers)
is a separate lever, out of scope for Phase 3. The registry feed and op-log feeds are written under the
held partition just like the snapshot is today.

## 4. Compaction (sub-phase 3b)

Logs grow unbounded; cold-start fold reads each from index 0. Bound both with **per-device compaction**:
periodically (every N ops or T) a device writes a **checkpoint entry** capturing the net effect of its
own ops so far (latest op per entity it has touched) and advances a small per-device "fold-from" pointer
so readers can start at the checkpoint instead of index 0. This is the Automerge
"snapshot + incremental chunks" model applied per device; it keeps each device's effective log to
O(entities it touches). Deferred to 3b — 3a ships without it (logs are small pre-production; `lastIndex`
caching already makes steady-state cheap).

## 5. Deletes (sub-phase 3c, optional)

3a keeps the **Phase 1 LWW tombstones** (`deletedAt`/`removedAt`/`revokedAt`): simple, already proven,
already converge. The rigorous upgrade (§6.3 of the plan) — **OR-Set** (observed-remove, add-wins via
per-add dots) and **version vectors** with **causal-stability tombstone GC** — is the optional tail 3c,
warranted only once tombstone accretion becomes a measured problem. The op-log structure is naturally
compatible: each op already is/can-carry a dot (`deviceId × seq`).

## 6. Verification

- **Unit (lib):**
  - op encode/decode round-trip (incl. blob-spill if added).
  - **Differential fold equivalence** — for a generated op set, `fold(per-device logs)` ≡ the Phase 0–2
    snapshot merge of the same operations. This _locks Phase 3 to today's observable behaviour_ and is
    the key correctness gate.
  - registry merge — reuses the Phase 1 `mergeDevicesList` tests.
- **Integration (real Swarm):** adapt the proven `scripts/deletion-sync-test.ts` harness (two devices,
  one feed each). Assert: device B folds device A's appends and converges; deletions propagate;
  resurrection works; and **the shared `swarm-id-backup-v1` feed is never written** (the §7 invariant).
  Runs on the local bee-compose cluster and the public gateway (both validated during Phase 1).
- Each sub-phase leaves `pnpm check:all` green.

## 7. Sub-phase plan

| Sub-phase      | Scope                                                                                                                                                                                                                                  | Exit                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **3a**         | Device-registry feed + per-device op-log write/fold; cut `createSyncAccount`/refresh/restore/proxy over to it; **delete** the shared-snapshot publish + `verifyWon` loop. Keep Phase 1 tombstones. Hard cutover, new versioned topics. | `check:all` green; differential fold test passes; two-device gateway run converges with no shared-feed write. |
| **3b**         | Per-device compaction (checkpoints + fold-from pointer).                                                                                                                                                                               | Bounded cold-start fold; equivalence preserved.                                                               |
| **3c** _(opt)_ | OR-Set / version-vector + causal-stability tombstone GC.                                                                                                                                                                               | Tombstones GC'd once causally stable; differential test extended.                                             |

## 8. Critical files

**New (lib):**

- `lib/src/sync/op-log.ts` — `Op`/`LogEntry` schema (Zod), encode/decode, `replayOps`, `foldAccount`.
- `lib/src/sync/device-registry.ts` — registry feed read/write + merge (wraps `mergeDevicesList`).

**Reuse:**

- `lib/src/proxy/feeds/sequence/*` (sequential feed updater/finder), `lib/src/proxy/feeds/epochs/*`
  (registry latest-pointer).
- `lib/src/sync/merge-snapshot.ts` — `mergeConnectedApps`/`mergePostageStamps`/`mergeDevicesList` for the
  fold (Phase 1).
- `lib/src/proxy/upload.ts` (`uploadData`, `UploadTarget`), `download-data.ts`,
  `lib/src/utils/key-derivation.ts` (owner/encKey/topic).

**Modify:**

- `lib/src/sync/sync-account.ts` — write ops to the device's own feed via the coordinator instead of
  calling `publishAccountState`.
- `lib/src/sync/restore-account.ts` + `swarm-ui/src/lib/utils/refresh-account-from-swarm.ts` — fold
  instead of fetching the snapshot; same `applyRefreshed` output.
- `lib/src/swarm-id-proxy.ts` — registry-based discovery (`refreshDeviceRegistryFromSwarm`,
  `knownDeviceIdsForAccount`); publish-on-acquire → append an op + announce in the registry.

**Retire:** the shared-feed merge/`verifyWon` core of `lib/src/sync/publish-account-state.ts`
(`mergeSnapshotWithRemote` / `snapshotContainsContribution` keep their unit value for the differential
test but leave the write path).

## 9. Open questions

1. **Registry feed vs pure per-device discovery** — recommended: dedicated registry feed (robust);
   alternative is deriving peers from lock SOCs (no new shared feed, but ≤K live holders only).
2. **Blob-spill in 3a or defer** — inline-only first, add blob-spill when an entry first exceeds 4 KB.
3. **Scalar fields (name/default/settings) clock** — per-op `at` LWW across devices; confirm that's
   sufficient vs a dedicated "account meta" lane.
4. **>2 devices** — accept read-only extras (inherited K=2) for Phase 3; revisit raising K separately.
5. **Tombstone GC** — adopt 3c (OR-Set/VV) only when accretion is measured; otherwise rely on 3b
   compaction.

## 10. References

- [`Account-State-Refactor-Plan.md`](./Account-State-Refactor-Plan.md) §6 (design-space research), §7
  (phased direction — Phase 3 is the north star this expands), §6.5 (Swarm primitive mapping).
- [`Account-State-Refactor-Implementation-Log.md`](./Account-State-Refactor-Implementation-Log.md) —
  Phase 0/1/2 record; Phase 1 (#337) tombstones this fold reuses.
- Psaras & Sanjuán, _Merkle-CRDTs_; Almeida et al., _Delta-State CRDTs_; Shapiro et al., _OR-Set_;
  Automerge 2.0 incremental format (all linked in the refactor plan §10).
