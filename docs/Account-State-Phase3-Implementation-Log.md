# Account-State Phase 3 — Implementation Log

Living record of what each sub-phase/commit actually lands for the per-device op-log CRDT (Phase 3 of
the account-state refactor). Design rationale lives in
[`Account-State-Phase3-Design.md`](./Account-State-Phase3-Design.md); the broader refactor record is in
[`Account-State-Refactor-Implementation-Log.md`](./Account-State-Refactor-Implementation-Log.md).

Format mirrors the Phase 0/1/2 log: one entry per commit/checkpoint, what changed, and the green gate.

## Status

**Design settled (per-device snapshot-feed model; all §9 decisions resolved); implementation not
started.** Phase 3 builds on Phase 1 (#337, PR #372) — its merge primitives are reused by the fold.
Sub-phases:

- **3a** — device-registry feed + per-device **snapshot** feed write/fold + cutover (retire the
  shared-snapshot `verifyWon` publish). Keep Phase 1 tombstones. _Not started._
- **3c** _(optional)_ — OR-Set / version-vector tombstone GC. _Not started._
- _(optional, later)_ — op-log/delta feeds if per-change bandwidth is measured to matter
  (Design §4). _Not started._

> The snapshot-feed model is self-compacting (each feed is a latest-pointer), so the originally-planned
> "3b compaction" phase is dropped. See [`Account-State-Phase3-Design.md`](./Account-State-Phase3-Design.md) §2, §4, §11.

## 3a — per-device snapshot feed write/fold + cutover

**Commit `6dff115a` — `feat(sync): per-device snapshot feed + device-registry modules (Phase 3a,
additive)`.** The read/write/fold building blocks, no cutover yet. `pnpm check:all` green (795 lib
tests). On `feat/account-deletion-tombstones` (PR #372).

- **`lib/src/sync/device-state.ts`** — per-device feed `swarm-id-devstate-v1:<acct>:<dev>` on the
  existing epoch feed. `writeDeviceState` (own feed, **no** merge/`verifyWon`), `readLatestDeviceState`,
  `foldAccount` (merge K device views via the Phase 1 primitives + per-field scalar LWW),
  `DeviceStateSnapshotSchemaV1` (Zod; reuses `serializeConnectedApp`/`serializePostageStamp`).
- **`lib/src/sync/device-registry.ts`** — rare-write shared discovery feed
  `swarm-id-devreg-v1:<acct>` holding the device set + account-level immutables (createdAt, publicKey,
  partitionCount). `readDeviceRegistry` / `writeDeviceRegistry` (read-merge-write + re-announce
  verify-retry, reusing `mergeDevicesList`), `upsertDevice`.
- **`lib/src/sync/fold-account-from-swarm.ts`** — `foldAccountFromSwarm`: registry → fold all device
  state feeds. Single read entry point for restore/refresh/proxy.
- **Tests (`device-state.test.ts`)** — the correctness gate: `foldAccount` ≡ `mergeSnapshotWithRemote`
  over the same data (differential equivalence); stamp-tombstone propagation through the fold; per-field
  scalar LWW (concurrent name-vs-default both survive); registry-sourced device list.
- Barrel exports added (`sync/index.ts`, `index.ts`).

**Pending — commit 2 (cutover, hard switch):** `sync-account.ts` write → `writeDeviceState`;
`restore-account.ts` + `refresh-account-from-swarm.ts` read → `foldAccountFromSwarm`; `swarm-id-proxy.ts`
registry discovery + publish-on-acquire announce; retire the shared-feed `verifyWon` core of
`publish-account-state.ts`. Then the adapted multi-device integration run (local + gateway).

## 3c — OR-Set / version-vector GC

_(pending)_
