# Account state — the nested account document and how it converges across devices

Status: **implemented.** This describes the current account-state model and its multi-device sync. The
*write coordination* it rides on (the cross-tab lock + partition lease) is documented separately in
[`BatchWriteCoordinator.md`](./BatchWriteCoordinator.md); the postage partitioning scheme it shares a
batch with is in [`Postage-Batch-Partitioning.md`](./Postage-Batch-Partitioning.md).

## What it is

An **account is one nested document of record**: it owns its devices, connected apps, postage stamps, and
settings inline (no separate per-collection storage keys, no pointers). That document is persisted locally
(`serializeAccount`, `lib/src/utils/storage-managers.ts`) and synced across a user's devices over Swarm so
every device converges on the same account state.

Sync is **per-device feeds folded on read**, not a single shared document:

- each device publishes its **own full current view** to its **own** epoch feed — no shared SOC address,
  so no read-merge-rewrite and no write contention between devices;
- an append-only **roster** records which devices exist (discovery);
- a reader **folds** the roster + every device's latest view into one converged account using
  last-writer-wins (LWW) merges with tombstones.

There is no central authority and no Byzantine tolerance — see [Assumptions](#assumptions).

## The account document

`Account` (`lib/src/types.ts` / `schemas.ts`), serialized by `serializeAccount`:

| Field                                              | Notes                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `id`, `name`, `type`, `createdAt`                  | `type` ∈ passkey / ethereum / agent (+ type-specific fields, e.g. `credentialId`) |
| `derivationKey`, `publicKey`                       | `derivationKey` is the shared account key every device holds (see Assumptions)    |
| `devices: Device[]`                                | each: `deviceId, name, createdAt, lastSignedInAt`, tombstone `removedAt?`          |
| `connectedApps: ConnectedApp[]`                    | each: app fields + `updatedAt`, optional `postageStampBatchID`, tombstone `revokedAt?` |
| `postageStamps: PostageStamp[]`                    | account-owned set; each: stamp fields + `createdAt`, tombstone `deletedAt?`        |
| `defaultPostageStampBatchID`                       | the account's default batch (stores account data; default for app uploads)        |
| `settings`                                         | e.g. `appSessionDuration`                                                         |
| `accountNameAt`, `defaultStampAt`, `settingsAt`    | **per-field LWW clocks** for the three scalars above (optional; fall back to `lastModified`) |
| `partitionCount`, `lastModified`                   | partition count for the shared batch; local modified clock                        |

Collections converge by **per-entry tombstones** (`removedAt` / `revokedAt` / `deletedAt`); the three
scalars converge by **per-field LWW** using their `*At` clocks. Tombstones are kept in the document (so a
delete propagates), not dropped.

## Position in the stack

```
                       ┌──────────────────────── per account (one shared owner) ────────────────────────┐
  discovery   ────────▶│  Roster feed        swarm-id-roster-v1:<accountId>     (sequential, append-only) │  RARE writes
   (rare)              │     device d appends only its own Device record at the next free index          │  (membership only)
                       ├───────────────────────────────────────────────────────────────────────────────┤
  hot path    ────────▶│  Device-state feed  swarm-id-devstate-v1:<accountId>:<deviceId>   (epoch feed)   │  FREQUENT writes,
   (per device)        │     latest pointer = that device's FULL current view (apps/stamps/scalars)       │  NO cross-device contention
                       └───────────────────────────────────────────────────────────────────────────────┘
  read        ────────▶  foldAccountFromSwarm = read roster → read each non-removed device's latest view
                          (in parallel) → foldAccount(views, rosterDevices)  → converged account
```

All feeds share **one owner** — the account backup key,
`deriveSecret(deriveSwarmEncryptionKey(derivationKey), "backup-key")` (same owner as the partition lock
SOCs). Feeds are distinguished by **topic**, not by signer; this is safe because every device is the same
user and already holds `derivationKey`. Payloads are encrypted with the swarm encryption key.

### Roster feed — `device-roster.ts`

`ROSTER_TOPIC_PREFIX = "swarm-id-roster-v1"`, a **sequential append-only** feed. Each device appends ONLY
its own `Device` record at the next free index, so a concurrent announce can never clobber a peer's entry
(worst case: two devices race the same fresh index; one append is re-added on its next sync). `readRoster`
scans in **parallel windows** (`ROSTER_SCAN_WINDOW`), folding the present entries by `deviceId` via
`mergeDevicesList` and skipping a transient gateway hole inside a window (only a fully-empty window means
end-of-feed). `ensureInRoster` appends only when the device is absent or its `removedAt` state changed —
keeping the roster a rare, membership-only write. (Replaced an earlier mutable registry doc that a caching
gateway could clobber.)

### Device-state feed — `device-state.ts`

`DEVICE_STATE_TOPIC_PREFIX = "swarm-id-devstate-v1"`, an **epoch feed** (`BasicEpochUpdater` /
`AsyncEpochFinder`, latest-pointer). Payload `DeviceStateSnapshotSchemaV1`: `connectedApps`,
`postageStamps` (with their tombstones), the three scalars as clocked `{ value, at }`, plus account
immutables ridden here so the fold can reconstruct them without a shared doc (`accountPublicKey`,
`accountCreatedAt`, `partitionCount`). Each device writes its **full merged view** to its **own** feed on a
local mutation — never on a read/fold — so write amplification is bounded and the fold is idempotent.

## Write path

Both writers go through `BatchWriteCoordinator.withWrite` (cross-tab lock + partition lease) →
`publishDeviceState` (`writeDeviceState` = upload the encrypted snapshot blob + advance this device's epoch
feed; then `onChunksUploaded` utilisation hook; then `ensureInRoster`):

- **Oneshot (SwarmID UI)** — `sync-account.ts`: `getAccountStateSnapshot` → `accountStateToDeviceView` →
  `coordinator.withWrite(target => publishDeviceState({ …, view, target, onChunksUploaded }), { wait: "skip" })`.
- **Persistent (proxy)** — `swarm-id-proxy.ts`: `schedulePublish` (debounced) on two triggers —
  `"acquired"` (`onLeaseAcquired`, announces a newly-joining device) and `"change"` (a local
  identity/stamp/rename delta) — runs `runAccountStatePublish` → `buildAccountStateSnapshotForPublish` →
  `publishDeviceState` via the coordinator. `refreshDeviceRegistryFromSwarm` uses `readRoster` to keep the
  known-device set current.

Because a device only ever writes its own feed, there is no merge-read-rewrite and no verify-won retry; the
partition lease still keeps two devices' writes slot-disjoint on the shared batch.

## Read path

`foldAccountFromSwarm({ bee, derivationKey, accountId })` (`fold-account-from-swarm.ts`): derive the
owner/encryption key → `readRoster` (empty ⇒ `undefined`, i.e. "no backup") → read each non-removed
device's latest view **in parallel** (`Promise.all`) → `foldAccount(views, rosterDevices)`. Two callers:

- **Restore (a new device signing in)** — `restore-account.ts` `restoreAccountFromSwarm` →
  `foldedToSnapshot` → an `AccountStateSnapshot` the sign-in/import flow consumes.
- **Refresh (an existing device)** — swarm-ui `refresh-account-from-swarm.ts` → merge the folded remote
  into the local account (`mergeConnectedApps` / `mergePostageStamps` / `mergeDevicesList` + `mergeDevices`
  to keep self first-class) → `accountsStore.applyRefreshed(...)` with `skipSync`; the three scalars are
  applied by per-field LWW (folded `at` > local `*At`).

`foldAccount` (`device-state.ts`) merges the collections with the primitives below and resolves each scalar
by `pickLatest` (per-field LWW), exposing the winning `*At`; `devices` come from the roster; account
immutables come from any view.

## Convergence rules — `merge-snapshot.ts`

| Collection      | Merge function       | Recency clock                         | Tombstone   |
| --------------- | -------------------- | ------------------------------------- | ----------- |
| postage stamps  | `mergePostageStamps` | `deletedAt ?? createdAt`              | `deletedAt` |
| devices         | `mergeDevicesList`   | `max(removedAt ?? 0, lastSignedInAt)` | `removedAt` |
| connected apps  | `mergeConnectedApps` | `max(revokedAt ?? 0, updatedAt)`      | `revokedAt` |

Last-writer-wins by recency; tombstones are retained and a later activity with a larger clock resurrects an
entry (e.g. a removed device re-signing in). Scalars (`accountName`, `defaultPostageStampBatchID`,
`settings`) converge by per-field LWW on their `*At` clocks, so concurrent changes to *different* scalars
on different devices both survive.

## Assumptions

1. **Cooperative, non-malicious devices.** Every device belongs to one user and holds `derivationKey`, so
   any device can sign any of the account's feeds. The scheme guarantees **convergence, not BFT** — a
   device that holds the key but ignores the protocol can corrupt state; defending against that is out of
   scope. This is what lets all feeds share one owner and be distinguished by topic.
2. **Loosely-synchronized clocks (~seconds).** The LWW merges and the partition lease TTLs lean on
   wall-clock timestamps; devices must agree to within a few seconds.
3. **Adding/removing a device is far rarer than using existing ones.** The roster is touched only on a
   membership change; the per-device state feeds carry all high-frequency data. So the residual gateway
   latency for a *fresh* roster entry (a newly-added device becoming discoverable within ~a minute) is
   acceptable, while already-known devices are immediate.

## Retired / legacy

The earlier model published one **shared** account-state snapshot feed (`swarm-id-backup-v1:account`) via
`publishAccountState`, using a read-merge-rewrite + `verifyWon` retry loop to arbitrate concurrent writers.
That is **gone** — replaced by the per-device feeds above. `publish-account-state.ts` now exports only
`ACCOUNT_SYNC_TOPIC_PREFIX` / `accountSyncTopic`, kept so a test can assert the legacy shared feed is
**never** written.

## Files & tests

| File                                                | Role                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `lib/src/sync/device-state.ts`                      | Per-device state feed: write/read, `accountStateToDeviceView`, `foldAccount` |
| `lib/src/sync/device-roster.ts`                     | Append-only roster: `readRoster`, `ensureInRoster`                |
| `lib/src/sync/fold-account-from-swarm.ts`           | `foldAccountFromSwarm` (roster + parallel device-feed reads)      |
| `lib/src/sync/merge-snapshot.ts`                    | LWW + tombstone merge primitives                                  |
| `lib/src/sync/restore-account.ts`                   | `restoreAccountFromSwarm` (new device)                            |
| `lib/src/sync/sync-account.ts`                      | Oneshot publish (SwarmID UI)                                      |
| `lib/src/swarm-id-proxy.ts`                         | Persistent publish (`runAccountStatePublish`) + triggers          |
| `lib/src/utils/storage-managers.ts`                 | `serializeAccount` (local persistence)                            |
| `swarm-ui/src/lib/utils/refresh-account-from-swarm.ts` | Refresh an existing device → `applyRefreshed`                  |
| `swarm-ui/src/lib/stores/accounts.svelte.ts`        | `applyRefreshed`, per-field scalar setters/clocks                 |

Tests: `merge-snapshot.test.ts`, `device-state.test.ts`, `device-roster.test.ts`, `sync-account.test.ts`
(unit/CI), and the opt-in live suite `lib/test/multi-device/` (`per-device-sync`, `per-device-sync-3`:
cross-device convergence, tombstone propagation, resurrection, and the "legacy shared feed never written"
invariant).
