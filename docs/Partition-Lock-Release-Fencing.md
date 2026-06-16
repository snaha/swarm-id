# Partition-Lock Release Fencing

How the partition-lock release is fenced against re-acquire eviction (the fix for #349).
Builds on the verified Bee semantics in `Partition-Lock-Hardening-Plan.md` (Appendix) and
the partition-state eviction fixes; the multi-device protocol spec lives in
`docs-site/src/content/docs/multi-device-postage-batches.mdx`.

## Problem (#349)

`BatchWriteCoordinator.teardown()` fired `void lease.release(localCounter)` detached and
**off the batch write lock**. `release()` is a slow publish (~33 chunks) **then** a
sentinel write. If the same device re-authenticated and re-acquired the partition while the
old release was still publishing, the late sentinel landed afterwards. Bee resolves
same-address SOC conflicts deterministically by **postage stamp timestamp** (newer
replaces; `reserve.go:139-219`), and stamps are minted at `stamp()` time — so the stale
sentinel **reliably** replaced the successor's claim whenever the release completed after
the re-acquire (not a rare arrival-order race). Peers then read "released" and could claim
while the successor still believed it held the partition → two writers on one partition.

Aggravator: the sentinel used to mint a **fresh** generation, so generation comparison
favored the stale sentinel — and the same fresh-generation sentinel could clobber a
legitimate **peer** claim in the lease-expired-then-release race.

## Implementation

The fix is four layers. A fifth fix surfaced during implementation: marked reserved chunks
now record their slot at marking time (`markReservedUtilizationChunk(address, slot)`),
because the teardown release publishes through an UNBOUND stamper whose `partition ?? 0`
fallback routed a partition-1 release's state chunks onto partition 0's reserved slots
(cross-partition eviction hazard).

### L0 — the teardown release is serialized under the batch write lock (primary fix)

`batch-write-coordinator.ts` `teardown()` wraps the detached release in `this.lock(...)`
(= `withBatchWriteLock(batchId, op)` — origin-wide Web Lock `swarm-write-${batchId}`; the
successor's `startLease`/`withWrite` already queue on it via `lockAndFlush`). The release
therefore fully completes before the successor's acquire can read or write the lock SOC;
the sentinel's stamp is minted strictly before the successor's claim stamp, so Bee's
last-writer-wins keeps the claim. Deterministic for the same-origin case — which is what
#349 is (same device by construction).

- `teardown()` stays synchronous and never throws (`void this.lock(async () => { try …
catch warn })`).
- The synchronous `invalidateLease()`/`unbindPartition()` ordering is untouched (#336).
- The publish runs on an unbound stamper — safe because `writePartitionState` routes every
  chunk to the reserved slot via its explicit `partition` argument.
- The no-Web-Locks fallback (Node/tests) runs `op` directly; only `oneshot` mode lives
  there and never releases.

### L1 — the sentinel carries the RELEASED claim's generation

`partition-lease.ts` `release()` captures `partition` + `generation` (+ `acquiredAt`) into
locals at the TOP (before the slow publish) and builds the sentinel from them, instead of a
fresh `{timestampMs: now(), tiebreaker}`. A release is an action on a specific claim;
fencing it with that claim's generation makes any later claim (successor or peer) logically
newer. No schema change.

`compareGenerations` is consumed only in the acquire verify step — where L1 also fixes a
latent false lost-race: a stale fresh-gen sentinel landing in a re-acquirer's 2 s guard
window used to compare greater → spurious `lost-race` → read-only. All free-detection keys
off `holderDeviceId === ""`, so old clients interoperate.

### L3 — generation-fenced sentinel write

`releasePartitionLock({bee, stamper, backupSigner, swarmEncryptionKey, partition, deviceId,
releasedGeneration, now?})` in `partition-lock.ts` returns `{ outcome: "released" |
"skipped"; observed?: PartitionLockPayload }`. It re-reads the lock, then decides in this
order:

| Observed                                                                     | Action | Why                                                                                      |
| ---------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `undefined` (missing or read error — `readPartitionLock` cannot distinguish) | write  | best-effort release; L1-fenced anyway                                                    |
| sentinel (any generation) — checked BEFORE the generation compare            | skip   | already released; rewriting mints a fresh stamp that could clobber an interleaved claim  |
| own device, `compareGenerations(gen, releasedGeneration) <= 0`               | write  | the claim being released; `<=` not `==` — a stale read of our own OLDER claim must write |
| own device, generation > released                                            | skip   | successor claim (the #349 case)                                                          |
| foreign holder, live or expired                                              | skip   | never clobber a peer; expired already reads as takeable                                  |

- Skips are always logged (`console.info`) with the observed payload.
- `PartitionLease.release()` clears `self`/`holders` on BOTH outcomes; the publish +
  synced-reference + protected-bucket bookkeeping precede the sentinel and stay valid on
  skip.
- **Ghost-claim guard**: `acquirePartitionLock` takes an optional `shouldAbort?: () =>
boolean`, checked immediately before `writePartitionLock`. `PartitionLease` sets a
  `closed` flag at the top of `release()`, and `refresh()` passes `shouldAbort: () =>
this.closed`. Otherwise a teardown-overlapping `refreshTick` could write a ghost claim
  that L3 then refuses to clear (own-device-newer-generation is indistinguishable from a
  successor) → peers wait out the 30 s TTL. `refresh()` also re-checks `if (!this.self)
return false` after its await before dereferencing `this.self.partition`, fixing a latent
  TypeError when `release()` nulls `self` during the guard window.

### L2 — sentinel-triggered re-assert at upload start (defense in depth)

`ensureLeaseStillValid()`: when the read returns a sentinel while we hold, it
`await lease.refresh()`:

- `true` → re-asserted; bump `lastLeaseValidatedAt`, persist cache, proceed.
- `false` (peer claimed after the sentinel) → mirror the displaced branch exactly:
  `signalLeaseLost()` → `finalizeDemote()` → throw (breaker before unbind).
- throws (transient) → keep the lease, log, do NOT bump `lastLeaseValidatedAt`, proceed.
- It does NOT trigger on `undefined` (routine transient 500 — would add 2 s guard latency
  to uploads during Bee blips).

L2 does not shrink the primary #349 window — the 10 s freshness throttle
(`lastLeaseValidatedAt`, set at acquire) means a stale sentinel usually lands inside the
skip window. L0 closes the primary window; L2 catches late-converging sentinels (frozen
gateway caches, multi-tab adoption).

## Accepted residual

Cross-node lease-expired race: an expired holder's release re-read through its own node can
miss a peer's claim (frozen local store / no non-neighborhood convergence — see the
Hardening Plan appendix) → the fenced sentinel still physically lands (newer stamp) → a
third device may claim → dual-hold bounded by the existing ≤ 10 s displacement window
(refresh + `isDisplaced` + breaker). Only the contest-SOC direction (Hardening Plan
Phase 2) would improve this.

## Test coverage

- `partition-lock.test.ts`: `releasePartitionLock` table test (one case per row — asserts
  outcome + final SOC payload + no write on skips); the L1 verify-path improvement
  (re-acquirer parked in the controlled-wait guard, older-generation sentinel injected →
  `acquired`; companion: newer-generation foreign claim → still `lost-race`); `shouldAbort`
  flipping between pre-read and write → no write.
- `partition-lease.integration.test.ts`: the L1 sentinel generation is pinned in the
  release test; the #349 interleaving (park `release()` between publish and sentinel by
  gating `writePartitionState`, acquire a second same-device lease (g2), unpark → lock still
  holds g2, release resolves); peer variant via injected `now` (lease lapses, DEVICE_B
  claims while parked → B's claim survives); ghost-claim/TypeError test (refresh parked in
  guard, `release()` runs → no ghost write, no throw).
- `batch-write-coordinator.test.ts`: L0 ordering (release completes before the successor's
  lock read — call-order spies); L2 branches (re-assert before op / demote+throw with
  breaker-before-unbind / refresh-throw keeps lease).
