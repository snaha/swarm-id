# Multi-Device SwarmID — Partition-Lease iteration 3: 3+ devices sharing 2 partitions

## Context

After iteration 2 landed (per-partition lock SOC, write-wait-verify protocol with deterministic generation fencing), at most `PARTITION_COUNT` devices can be active at the same time. The default is `PARTITION_COUNT = 2`. A 3rd device that signs into the same account currently falls into the read-only branch when it tries to upload — every partition is held by a live foreign holder.

We want a 3rd (or 4th, …) device to be able to upload against the same shared postage batch by joining when one of the active devices stops refreshing its lease. The system stays at 2 partitions; devices take turns.

### Constraints

Confirmed with the user:

- `PARTITION_COUNT` stays at 2. Small batches (e.g. depth 20) have only ~14 usable per-bucket slots; splitting four ways would leave three slots/device — too tight.
- Max acceptable join latency: 30 s in the foreground. Can be partially hidden behind sign-in UX flow time (passkey prompt, navigation, …).
- No migration of existing accounts needed — constants and behaviour can change freely.
- No force-takeover in this iteration. Defer to a later iteration; can be layered on without breaking the v1 protocol.
- On displacement: demote silently. A modal in the SwarmID management UI can be added later.
- Sign-in should help by attempting a partition claim asynchronously, so the user's first upload doesn't pay the full lease TTL.

### Out of scope (deferred to later iterations)

- An explicit "force takeover" button in the SwarmID UI.
- A "yield voluntarily" sentinel write — a device that knows it's been idle/displaced writes `NO_HOLDER_DEVICE_ID` to its partition's lock SOC so peers see the slot free immediately, without waiting out the TTL.
- Displacement modal in the SwarmID management UI.
- Bigger `PARTITION_COUNT` (4+) for deeper batches, possibly per-account.
- Intent-SOC handshake (Protocol P2 from the design brainstorm) when fast heartbeats become a bandwidth issue.

## Plan

Five small changes. They compose into "a 3rd device joins within ≤ 30 s, automatically and safely."

### 1. Tighten the lease timing

`lib/src/utils/batch-utilization.ts`:

```ts
LEASE_TTL_MS:      1 h    →   30 s
LEASE_REFRESH_MS: 15 min  →   10 s    // TTL / 3, headroom for missed refreshes
```

`PARTITION_LOCK_GUARD_MS` stays at 2 s — it's the SOC propagation guard, orthogonal to the lease cadence.

Net behaviour: an active device writes the lock SOC every 10 s; if it stops for >30 s, any peer can take its slot. Bandwidth: one ~150-byte SOC write per device per 10 s — negligible against typical batch slot budgets.

### 2. Detect displacement silently in the proxy's refresh tick

Today, `PartitionLease.refresh()` returns `undefined` on `outcome !== "acquired"` (`lib/src/sync/partition-lease.ts`). The proxy's `scheduleLeaseRefresh` interval handler (`lib/src/swarm-id-proxy.ts`) currently just logs a warning when refresh fails — it doesn't react to displacement.

Replace that branch with the demotion sequence:

```ts
.then(async (refreshed) => {
  if (refreshed) {
    // existing happy path — update LeaseState, IndexedDB metadata.
    return
  }
  // We've been displaced (blocked) or lost a race. Demote silently.
  this.tearDownPartitionLease()                  // clears interval, LeaseState, partitionLease
  this.stamper?.unbindPartition?.()              // see change 3
  this.removeSelfFromActiveDevices(accountId)    // local state mirror; storage listener fires triggerSync
})
```

`removeSelfFromActiveDevices` is a small helper next to `persistActiveDevices` in `swarm-id-proxy.ts` — filters out the local device entry from the account's `activeDevices` in localStorage. The swarm-ui's storage listener (`accounts.svelte.ts`) sees the change and fires `triggerSync`, which republishes the snapshot with this device demoted.

A displaced device that subsequently tries to upload via the proxy enters the "no slot, wait" path from change 5.

### 3. `UtilizationAwareStamper.unbindPartition()`

`lib/src/utils/batch-utilization.ts` — `UtilizationAwareStamper`. Inverse of `bindPartition`:

```ts
unbindPartition(): void {
  this.partition = undefined
  this.partitionLocalCounter = undefined
}
```

Called from change 2 when displacement is detected and (for consistency) from the proxy's existing `tearDownPartitionLease`. Without this, a displaced stamper keeps stamping into its old partition's slot space — now held by a peer — and collides immediately.

### 4. Sign-in attempts a partition claim

Hide the join latency under the sign-in UX flow time (passkey prompt, navigation, etc. — usually multiple seconds in practice).

In `swarm-ui/src/routes/(app)/(create)/signin/passkey/+page.svelte` (and `signin/ethereum/+page.svelte`), after `restoreAccountToStores(...)` returns and before `navigateToConnectOrHome()`:

```ts
// Best-effort: claim a partition now so the first upload doesn't pay
// the full TTL wait. Fire-and-forget; on failure the proxy's
// upload-time flow handles it.
void claimPartitionDuringSignin(restoredAccount)
```

`claimPartitionDuringSignin` is a new helper in `swarm-ui/src/lib/utils/`:

1. Derive `backupSigner` from `account.derivationKey` (same chain as `refreshAccountFromSwarm`).
2. Get a stamper from `postageStampsStore.getStamper(...)`.
3. Pick a candidate partition: scan partitions, find first non-self / non-expired entry, otherwise loop up to 30 s; abort if still nothing.
4. Call `acquirePartitionLock({ ... })` (the lib's existing primitive).
5. On `acquired`: bind the partition on the stamper, update `accountsStore.applyRefreshedSnapshot(...)` with the new `activeDevices`. The storage listener picks up the change → fires `triggerSync` → snapshot publishes.

If the user navigates away during step 3's wait, the helper aborts cleanly via an `AbortController` hooked to a `beforeunload` listener.

### 5. Wait-for-slot in `ensurePartitionLease`

`swarm-id-proxy.ts:ensurePartitionLease`. When `acquirePartitionLease` finishes with `isReadOnly = true`, retry every `LEASE_REFRESH_MS` (10 s) up to a hard cap of 30 s. If still no slot at the cap, throw — the upload fails with a clear error rather than silently colliding with an active peer's stamp.

```ts
const startedAt = Date.now()
while (Date.now() - startedAt < SLOT_WAIT_TIMEOUT_MS) {
  await this.acquirePartitionLease(accountInfo)
  if (!this.isReadOnly) return           // slot acquired
  await sleep(LEASE_REFRESH_MS)
}
throw new Error("No partition available — all slots are held by other devices.")
```

The current `PARTITION_LEASE_ACQUIRE_TIMEOUT_MS = 10000` (the wrapper Promise.race in `ensurePartitionLease`) needs to grow to ≥ `SLOT_WAIT_TIMEOUT_MS + LEASE_REFRESH_MS` — bump to 45 s.

## Worst-case timings

- Foreground 3rd-device sign-in: best case partition claim completes during sign-in UX (~2–5 s). Worst case (both partitions live + freshly refreshed at moment of sign-in): the proxy waits ≤ 30 s on the first upload before either succeeding or failing with a clear error.
- Background heartbeat: every active device writes a lock SOC every 10 s.
- Displaced-device recovery: noticed on next refresh tick (≤ 10 s), then demoted silently.

## Files modified

- `lib/src/utils/batch-utilization.ts` — tighter `LEASE_TTL_MS` / `LEASE_REFRESH_MS`; new `UtilizationAwareStamper.unbindPartition()`.
- `lib/src/swarm-id-proxy.ts` — displacement branch in `scheduleLeaseRefresh`; wait-for-slot in `ensurePartitionLease`; small `removeSelfFromActiveDevices` helper; bump `PARTITION_LEASE_ACQUIRE_TIMEOUT_MS` to 45 s.
- `swarm-ui/src/lib/utils/claim-partition-during-signin.ts` — **new** sign-in helper.
- `swarm-ui/src/routes/(app)/(create)/signin/passkey/+page.svelte` and `signin/ethereum/+page.svelte` — fire the helper after `restoreAccountToStores`.

### Tests

- `lib/src/sync/partition-lease.integration.test.ts` — existing tests import `LEASE_TTL_MS` directly so most recalibrate. Anything that asserts absolute durations may need adjustment.
- New integration test for "displaced on refresh": a foreign device writes a higher-generation lock SOC after our acquire; our next refresh sees it; we expect the lease state to demote.
- New unit test for `UtilizationAwareStamper.unbindPartition()` clearing `partition` and `partitionLocalCounter`.

After lib changes: rebuild the bundle (`pnpm --filter @snaha/swarm-id build`) so the demo and swarm-ui iframe pick up the new behaviour.

## Verification

End-to-end with three browser profiles on the same machine, all pointing at `localhost:1633`:

1. Sign in on Firefox → upload → Firefox is on partition 0.
2. Sign in on Chrome → upload → Chrome is on partition 1.
3. Sign in on a 3rd profile. Devices tab shows that profile as inactive within a few seconds. Trigger an upload from its demo:
   - If Firefox or Chrome happened to be idle (no refresh within 30 s), the 3rd profile claims that slot on the first attempt.
   - If both are actively refreshing, the 3rd profile's upload waits ~30 s and then either succeeds (a slot opened) or errors with "no partition available".
4. Stop Firefox (close the tab). Within 30 s, the 3rd profile picks up partition 0. Verified via lock SOC: `holderDeviceId` becomes the 3rd profile's deviceId.
5. Reopen Firefox. Its next refresh attempt sees the lock SOC held by the 3rd profile → silent demote, Devices tab shows Firefox as inactive within ~10 s.
6. `pnpm check:all` stays green. New integration test for displacement-on-refresh and the `unbindPartition` unit test both pass.

## Followups (later iterations)

- **Force takeover** — explicit UI button to displace a specific active device.
- **Yield voluntarily** — a device writes the `NO_HOLDER_DEVICE_ID` sentinel when it knows it's idle or being displaced, so peers don't wait the full TTL.
- **Displacement modal in SwarmID UI** — replace silent demote with a visible "your slot was taken" notification.
- **Per-account `partitionCount` override** — bigger values for deeper batches.
- **Intent SOC** — Protocol P2 from the design brainstorm, layered over P1's tighter timing if heartbeat bandwidth becomes a problem.
