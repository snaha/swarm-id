# Partition-Lock Release Fencing — Fix Plan for #349

Status: **implemented** on `fix/lock-release-fencing` (stacked on
`fix/partition-state-eviction`) — L0 + L1 + L3 + L2 as below, plus one extra fix found
during implementation: marked reserved chunks now record their slot at marking time
(`markReservedUtilizationChunk(address, slot)`), because the teardown release publishes
through an UNBOUND stamper whose `partition ?? 0` fallback routed a partition-1 release's
state chunks onto partition 0's reserved slots (cross-partition eviction hazard).
Builds on the verified Bee semantics in `Partition-Lock-Hardening-Plan.md` (Appendix) and
the partition-state eviction fixes.

## Problem (#349, sharpened by research)

`BatchWriteCoordinator.teardown()` fires `void lease.release(localCounter)` detached and
**off the batch write lock**. `release()` = slow publish (~33 chunks) THEN sentinel write.
If the same device re-authenticates and re-acquires the partition while the old release is
still publishing, the late sentinel lands afterwards. Verified Bee fact that upgrades the
severity: same-address SOC conflicts are resolved deterministically by **postage stamp
timestamp** (newer replaces; `reserve.go:139-219`), and stamps are minted at `stamp()`
time — so the stale sentinel **reliably** replaces the successor's claim whenever the
release completes after the re-acquire (not a rare arrival-order race). Peers then read
"released" and may claim while the successor still believes it holds → two writers on one
partition.

Aggravator: the sentinel currently mints a **fresh** generation
(`partition-lease.ts`, release payload), so generation comparison favors the stale
sentinel — and the same fresh-generation sentinel can clobber a legitimate **peer** claim
in the lease-expired-then-release race.

## Fix: four layers

### L0 — serialize the teardown release under the batch write lock (primary fix)

`batch-write-coordinator.ts` `teardown()`: wrap the detached release in
`this.lock(...)` (= `withBatchWriteLock(batchId, op)` — origin-wide Web Lock
`swarm-write-${batchId}`; the successor's `startLease`/`withWrite` already queue on it via
`lockAndFlush`). The release then fully completes before the successor's acquire can read
or write the lock SOC; the sentinel's stamp is minted strictly before the successor's
claim stamp, so Bee's LWW keeps the claim. Deterministic for the same-origin case — which
is what #349 is (same device by construction).

- `teardown()` stays synchronous and never throws (`void this.lock(async () => { try …
  catch warn })`).
- Keep the synchronous `invalidateLease()`/`unbindPartition()` ordering untouched (#336).
- The publish then runs on an unbound stamper — safe: `writePartitionState` routes every
  chunk to the reserved slot via its explicit `partition` argument. Comment it.
- No-Web-Locks fallback (Node/tests) runs `op` directly; only `oneshot` mode lives there
  and never releases.

### L1 — the sentinel carries the RELEASED claim's generation

`partition-lease.ts` `release()`: capture `partition` + `generation` (+ `acquiredAt`)
into locals at the TOP (before the slow publish) and build the sentinel from them,
replacing the fresh `{timestampMs: now(), tiebreaker}`. A release is an action on a
specific claim; fencing it with that claim's generation makes any later claim (successor
or peer) logically newer. No schema change.

Reader audit (verified): `compareGenerations` is consumed only in the acquire verify
step — where L1 *fixes a latent false-lost-race* (a stale fresh-gen sentinel landing in a
re-acquirer's 2 s guard window currently compares greater → spurious `lost-race` →
read-only). All free-detection keys off `holderDeviceId === ""` — unchanged; old clients
interoperate. The docs-site `:::note` ("the release advances the generation…") must be
reworded: the sentinel now carries the released claim's generation, whose tiebreaker is
still the releasing device's (claims always mint their own).

### L3 — generation-fenced sentinel write

New `releasePartitionLock({bee, stamper, backupSigner, swarmEncryptionKey, partition,
deviceId, releasedGeneration, now?})` in `partition-lock.ts`, returning
`{ outcome: "released" | "skipped"; observed?: PartitionLockPayload }`. Re-read the lock,
then decide IN THIS ORDER:

| Observed | Action | Why |
| --- | --- | --- |
| `undefined` (missing or read error — `readPartitionLock` cannot distinguish) | write | best-effort release; L1-fenced anyway |
| sentinel (any generation) — check BEFORE generation compare | skip | already released; rewriting mints a fresh stamp that could clobber an interleaved claim |
| own device, `compareGenerations(gen, releasedGeneration) <= 0` | write | the claim being released; `<=` not `==` — a stale read of our own OLDER claim must not skip |
| own device, generation > released | skip | successor claim (the #349 case) |
| foreign holder, live or expired | skip | never clobber a peer; expired already reads as takeable |

- Always log skips (`console.info`) with the observed payload.
- `PartitionLease.release()` clears `self`/`holders` on BOTH outcomes; the publish +
  synced-reference + protected-bucket bookkeeping precede the sentinel and stay valid on
  skip.
- **Ghost-claim guard**: add optional `shouldAbort?: () => boolean` to
  `acquirePartitionLock`, checked immediately before `writePartitionLock`;
  `PartitionLease` sets a `closed` flag at the top of `release()` and `refresh()` passes
  `shouldAbort: () => this.closed`. Otherwise a teardown-overlapping `refreshTick` can
  write a ghost claim that L3 then refuses to clear (own-device-newer-generation is
  indistinguishable from a successor) → peers wait out the 30 s TTL. Also fix the latent
  TypeError: `refresh()` must re-check `if (!this.self) return false` after its await
  before dereferencing `this.self.partition` (`partition-lease.ts:404-414`).

### L2 — sentinel-triggered re-assert at upload start (defense in depth ONLY)

`ensureLeaseStillValid()`: when the read returns a sentinel while we hold →
`await lease.refresh()`:
- `true` → re-asserted; bump `lastLeaseValidatedAt`, persist cache, proceed.
- `false` (peer claimed after the sentinel) → mirror the displaced branch exactly:
  `signalLeaseLost()` → `finalizeDemote()` → throw.
- throws (transient) → keep the lease, log, do NOT bump `lastLeaseValidatedAt`, proceed.
- Do NOT trigger on `undefined` (routine transient 500; would add 2 s guard latency to
  uploads during Bee blips).

**Honest framing**: L2 does NOT shrink the primary #349 window — the 10 s freshness
throttle (`lastLeaseValidatedAt`, set at acquire) means the stale sentinel usually lands
inside the skip window. L0 closes the primary window; L2 catches late-converging
sentinels (frozen gateway caches, multi-tab adoption).

## Accepted residual (document, don't claim fixed)

Cross-node lease-expired race: an expired holder's release re-read through its own node
can miss a peer's claim (frozen local store / no non-neighborhood convergence — see
Hardening Plan appendix) → the fenced sentinel still physically lands (newer stamp) → a
third device may claim → dual-hold bounded by the existing ≤ 10 s displacement window
(refresh + `isDisplaced` + breaker). Only the contest-SOC direction (Hardening Plan
Phase 2) would improve this.

## Tests

- `partition-lock.test.ts`: `releasePartitionLock` table test (one case per row; assert
  outcome + final SOC payload + no write on skips); L1 verify-path improvement
  (re-acquirer parked in the controlled-wait guard, inject an older-generation sentinel →
  `acquired`; companion: newer-generation foreign claim → still `lost-race`);
  `shouldAbort` flips between pre-read and write → no write.
- `partition-lease.integration.test.ts`: pin the L1 sentinel generation in the existing
  release test; the #349 interleaving (park `release()` between publish and sentinel by
  gating `writePartitionState`, acquire a second same-device lease (g2), unpark → lock
  still holds g2, release resolves); peer variant via injected `now` (lease lapses,
  DEVICE_B claims while parked → B's claim survives); ghost-claim/TypeError test
  (refresh parked in guard, `release()` runs → no ghost write, no throw).
- `batch-write-coordinator.test.ts`: L0 ordering (release completes before the
  successor's lock read — call-order spies); L2 branches (re-assert before op /
  demote+throw with breaker-before-unbind / refresh-throw keeps lease).

## Docs

- `multi-device-postage-batches.mdx`: reword the tiebreaker `:::note`; Lease lifecycle
  release description (publish → fenced sentinel, skipped when a newer claim is visible;
  teardown release serialized under the batch write lock); add the cross-node residual;
  porting checklist item 3 gains the release-fencing semantics.
- `Partition-Lock-Hardening-Plan.md`: cross-reference this plan from a short #349 section.

## Verification

1. `pnpm --filter @snaha/swarm-id test`, `pnpm check:all`, `pnpm build:docs`.
2. Manual (local cluster, rebuilt lib): connect demo, upload (acquire), sign out and
   immediately re-connect — the sidebar re-acquires and keeps the partition (no released
   flap), a subsequent upload works, and the proxy console shows the release-skip info
   log when the interleaving is hit.
