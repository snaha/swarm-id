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

**Commit `122d65cf` — `feat(sync): cut over to per-device snapshot feeds; retire shared publish (Phase
3a)`.** The hard switch. `pnpm check:all` green (784 lib tests); verified end-to-end on the local
cluster. On `feat/account-deletion-tombstones` (PR #372).

- **Write** — `device-state.ts` gains `publishDeviceState` (writes this device's own feed via
  `writeDeviceState`, then ensures the registry lists it — a single read-merge-write, skipped once
  present; a dropped announce re-adds on the next sync). `sync-account.ts` and
  `swarm-id-proxy.ts:runAccountStatePublish` call it instead of `publishAccountState`. Utilisation
  tracking preserved via the returned chunk addresses.
- **Read** — `restore-account.ts` + `swarm-ui/.../refresh-account-from-swarm.ts` use
  `foldAccountFromSwarm` (registry → fold all device feeds). Restore projects the fold onto the legacy
  `AccountStateSnapshot` shape, so the swarm-ui sign-in/import callers are unchanged.
- **Proxy** — `refreshDeviceRegistryFromSwarm` reads the registry feed for discovery; the announce-once
  gate is now "registry already lists me".
- **Retire** — `publish-account-state.ts` keeps only the legacy topic constant (for the invariant test);
  `publishAccountState`/`verifyWon`/`remoteFeedHasDevice` + their test removed. `sync-account.test.ts`
  rewritten to the per-device path.
- **Deferred** — scalars (name/default/settings) ride the snapshot's `lastModified` clock; true
  per-field clocks + cross-device scalar propagation on refresh are a follow-up (the wire format already
  carries per-field clocks).

**Integration (`scripts/per-device-sync-test.ts`, untracked).** Two devices each publish their own feed

- registry; a reader folds and converges. **9/9 checks pass on BOTH the local bee-compose cluster AND the
  public gateway** (`api.gateway.ethswarm.org`, real Gnosis batch): cross-device convergence (A's stamp +
  B's app + both devices), stamp-delete tombstone propagation, device removal + resurrection, and the
  **§7 invariant** — the old shared `swarm-id-backup-v1` feed is never written. Runners:
  `scripts/run-gateway.sh <tsx-script>` (env-setup once; drives any integration script).

**Gateway finding — registry negative-caching.** The per-device device-state feeds propagate fine on the
gateway, but the **device-registry** (the one residual shared feed) is slow there: it has a _static_
feed address, and `publishDeviceState` READS it (to decide whether to announce) before WRITING it. The
gateway negative-caches the 404 for ~50 s, so a fresh announce isn't readable until the cache clears
(measured t+56 s vs t+8 s for a write with no pre-read). Two consequences on the gateway: (a) ~50 s read
latency for a new device; (b) a second device announcing inside that window can't see the first and its
read-merge-write **clobbers** the peer. Spacing announces beyond the window (`PROP_DELAY_MS≈70 s`, the
gateway runner's default) makes it converge 9/9. This is the same gateway 404-caching the partition
intent-SOCs rotate addresses to avoid — it validates killing shared-feed reliance (the hot path is now
robust) and flags the registry as the next thing to harden.

### Status (3a)

Phase 3a **done & green** — cutover landed + verified on the local cluster **and the public gateway**
(9/9 both). Known follow-ups: (1) **harden the registry for high-latency/caching gateways** — a
verifyWon-style read-back retry, address rotation, or per-device registry feeds (so a static-address
read-before-write can't negative-cache/clobber); (2) per-field scalar clocks + scalar propagation on
refresh; (3) the new `ui/` package still on the old read/write path; (4) Phase 3c (OR-Set/VV GC).

## 3c — OR-Set / version-vector GC

_(pending)_
