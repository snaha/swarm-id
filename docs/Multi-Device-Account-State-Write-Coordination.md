# Multi-Device Account-State Write Coordination

Status: **Part A — design + implementation in progress.** Part B — designed, deferred.

Companion to `Multi-Device-Partition-Lease.md` (which solves a _different_ problem — chunk-slot
collisions) and `BatchWriteCoordinator-Design.md`.

## Problem

An account's state — `metadata` (name, default stamp, devices, `partitionCount`), `identities[]`,
`connectedApps[]`, `postageStamps[]` — is published to **one shared epoch feed** per account:

```
topic = swarm-id-backup-v1:account:<accountId>
owner = backup signer (derived from the account's swarm encryption key via "backup-key")
```

Every active device writes that **same** feed. The partition lease (`Multi-Device-Partition-Lease.md`)
prevents two devices from handing the same `(bucket, slot)` to different _chunks_, but it does nothing
for the feed _pointer_: the account-state publish is a classic lost-update.

### Why partitioning doesn't help here

The hazard is not chunk collision — it's a concurrent update to a single shared feed entry.
`lib/src/sync/sync-account.ts` publishes with **read → merge → write** and no conflict detection:

1. `tryFetchLatestSnapshot` reads the current remote snapshot (`sync-account.ts:479`).
2. `mergeSnapshotWithRemote` folds the remote into the local state (`:485`).
3. `updater.update` writes the new snapshot reference to the epoch feed (`:571`).
4. The post-write probe (`:583`) only checks the root chunk is _retrievable_ — it never checks the feed
   still points at our write.

The feed update is **last-writer-wins at the SOC level** (same owner + topic ⇒ same SOC address ⇒ the
later signed write silently overwrites). So in the TOCTOU window between device B's read (step 1) and
B's write (step 3), if device A publishes, **B orphans A's snapshot**, and B's merge only folded in
remote state _as of B's read_ — A's unique additions are lost.

### What is and isn't already safe

- **Within one device:** all writers — the management tab, the connect popup, and the proxy iframe — are
  the same origin and share the `swarm-write-<batchId>` Web Lock (`withBatchWriteLock`,
  `sync-account.ts:665`; proxy `swarm-id-proxy.ts:592`). `navigator.locks` is per-origin, so the lock
  serializes the entire read-merge-write across all same-device contexts. **No within-device lost
  update.** The hazard is **cross-device only** — there is no lock that spans devices.
- **The trigger surface is broad.** Account state is _not_ only mutated from the management UI. Ordinary
  app usage mutates it: connecting a dApp runs in the swarm-ui connect popup, which calls
  `connectedAppsStore.addOrUpdateApp` → `triggerSync` (a publish). A dApp-side disconnect goes through
  the proxy's `clearAuthData` → library `disconnectApp` (`storage-managers.ts:248`), which writes the
  shared connected-apps storage _directly_ and does **not** publish. So two devices each just _using_
  dApps can produce concurrent account-state writes — the race is a normal-usage event, not a rare
  manual-edit coincidence.
- **The merge is mostly CRDT-friendly.** `mergeSnapshotWithRemote` (`lib/src/sync/merge-snapshot.ts`)
  unions arrays by natural key (devices by `deviceId` with a `lastSignedInAt` tiebreak; identities by
  `id`; connectedApps by `identityId:appUrl`; stamps by `batchID`). The genuinely lossy paths are
  concurrent edits to the **same scalar** (`accountName`, `defaultPostageStampBatchID`) or the **same
  array item** (rename one identity, re-grant one app) — these stay local-wins. `partitionCount` is
  effectively set-once (only the `(create)/*` routes write it), so it's not a real conflict field.

## Solution — Part A: optimistic verify-retry (this change)

Recreate, across devices, the serialize-read-merge-write guarantee the Web Lock already gives within a
device — via detect-and-retry, since no lock can span devices.

In `sync-account`'s `runSync`, **inside** the existing `withBatchWriteLock`, after writing the feed:

1. Re-read the latest feed reference with the same finder `tryFetchLatestSnapshot` uses
   (`AsyncEpochFinder.findAt(now)` → `refBytes`).
2. If it equals the reference **we** just wrote → we won; proceed to the existing retrievability probe
   and return success.
3. Otherwise a peer overwrote us → re-fetch the now-latest remote, `mergeSnapshotWithRemote` the
   **original local state** onto it (always the captured local `state`, never our already-merged
   result), re-upload, and re-write the feed.
4. Cap at `MAX_PUBLISH_RETRIES` with a small **jittered backoff** so retries straddle the one-second
   epoch-slot boundary and don't livelock. Only the _loser_ of a collision retries; convergence holds
   because the merge is a union — each retry folds in the peer's additions.

### Why this converges

If A and B write within the same second they target the same epoch slot ⇒ same SOC address ⇒ one wins
by LWW. The winner re-reads, sees its own reference, and returns. The loser re-reads, sees the winner's
reference, re-merges its local additions onto the winner's now-published snapshot, and writes a fresh
epoch. After at most a few rounds the feed converges to the union of both devices' changes. Additions
are never lost; only same-scalar / same-item concurrent edits remain last-writer-wins (by design — see
below).

### Tradeoffs / notes

- **Read-after-write visibility.** The verify read must observe a peer's just-written SOC. The existing
  code already reads back the root chunk post-write, so this is consistent with current expectations;
  on a lagging Bee node the worst case is a redundant extra write, not incorrectness. (See
  `.claude/rules/bee-cluster.md` on `deferred:false` receipt latency.) On the final attempt, if the
  feed still doesn't show our reference, we return `success-unverified` rather than failing.
- **Scope of conflict resolution is unchanged.** Per product direction, merge semantics do not change:
  same-scalar and same-item concurrent edits stay local-wins (LWW). Making those latest-wins would
  require per-field/per-item timestamps — explicitly out of scope.
- **New constants** (near the other sync constants in `sync-account.ts`): `MAX_PUBLISH_RETRIES`,
  `PUBLISH_RETRY_BACKOFF_MS`.

### Files (Part A)

- `lib/src/sync/sync-account.ts` — wrap the publish (merge → serialize → upload → utilization → feed
  update) in the bounded verify-retry loop; add the post-write reference comparison and constants.
- `lib/src/sync/sync-account.test.ts` — add the verify-retry coverage.

## Solution — Part B: account-object storage model (deferred)

Today `getAccountStateSnapshot` (`sync-account.ts:293`) assembles the snapshot by fanning out across
four separate stores (`accountsStore`, `identitiesStore`, `connectedAppsStore`, `postageStampsStore`),
and `restoreAccountToStores` / `refresh-account-from-swarm.ts` scatter a fetched snapshot back into
them. Part B consolidates these into **one per-account aggregate object** that round-trips 1:1 with what
is published and merged:

- Reuse `AccountStateSnapshot` as the canonical in-app account object (`metadata`, `identities[]`,
  `connectedApps[]`, `postageStamps[]`) keyed by `accountId`. Device-local-only fields stay local
  (`derivationKey` — already never in the snapshot; and the _session_ aspect of connected apps,
  `connectedUntil`, which `restore-account.ts:31` already resets).
- One `mergeAccount(local, remote)` (the current `mergeSnapshotWithRemote` body, semantics unchanged),
  reused for the publish merge and for restore/refresh apply.
- `getAccountStateSnapshot` becomes a trivial read of the object instead of a 4-store assembly.

### Critical constraint — preserve the proxy auth handshake

The proxy **subscribes** to the connected-apps storage (`swarm-id-proxy.ts:300` →
`handleConnectedAppsChange`) to detect new connections and authenticate, and writes it on logout
(`disconnectApp`). `connectedApps` therefore doubles as a device-local session channel between the
connect popup and the proxy iframe. Part B must keep a connected-apps accessor (the existing
`createConnectedAppsStorageManager` contract) backed by the `connectedApps` slice of the account object
(or a projection kept in lockstep), so the popup→proxy handshake and proxy `disconnectApp` behave
exactly as today.

## Alternatives considered (not chosen)

- **Per-device account-object feeds + merge-on-read** — each device writes its own feed (structurally
  race-free, pairs naturally with the account object). Rejected as the default: needs a device-roster
  bootstrap (the device list lives _inside_ the object you're trying to read) and read-time fan-out,
  cutting against "optimize the common case." Kept in reserve if real contention appears.
- **Single-writer election (account-state lease)** — reintroduces shared-lock-SOC contention and blocks
  a second device's edits until handoff/TTL. Rejected.
- **Per-field / per-item timestamps** to make same-scalar/same-item edits latest-wins — out of scope per
  "merge semantics unchanged."

## Verification

- **Unit** (`sync-account.test.ts`): stub the finder so the post-write read returns a _peer's_ reference
  ≠ ours → assert one re-merge + re-write, that both the peer's and our additions are present in the
  re-written object, and that the loop stops after `MAX_PUBLISH_RETRIES`. Reuse `merge-snapshot` tests
  for the union behaviour.
- **Integration:** two clients sharing an in-memory/mocked feed publish concurrently (A adds an
  identity, B adds a stamp) → assert the converged object contains both (no lost addition).
- **E2E** (two browser profiles, same passkey): each connects a _different_ dApp within a few seconds →
  both `connectedApps` appear on both devices after sync. Concurrent rename on A + add-stamp on B →
  stamp survives; account name is one of the two (LWW accepted, documented).
- `pnpm check:all` green; manual run via `pnpm dev` + `pnpm dev:bee:fresh` (do not run a manual
  `pnpm build` alongside the dev watcher).
