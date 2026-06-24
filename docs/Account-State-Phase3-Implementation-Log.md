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

_(entries added as commits land)_

## 3c — OR-Set / version-vector GC

_(pending)_
