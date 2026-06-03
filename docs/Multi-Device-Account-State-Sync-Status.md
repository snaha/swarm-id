# Multi-Device Account-State Sync — Status & Remaining Tasks

Living status doc for the "connected apps (and other account state) don't reach a 2nd device" work.
Companion to `Multi-Device-Account-State-Write-Coordination.md` (the concurrency/merge design) and
`Multi-Device-Partition-Lease.md` (chunk-slot partitioning — a _separate_ problem).

## The problem, end to end

Account state (`metadata` incl. devices + partitionCount, `identities[]`, `connectedApps[]`,
`postageStamps[]`) is published to one shared epoch feed per account
(`swarm-id-backup-v1:account:<id>`, owner = backup signer). A second device should see changes made on
the first. Two halves must both work:

1. **Publish** — the device that made a change uploads the snapshot + updates the feed.
2. **Restore/refresh** — the other device pulls the snapshot and applies it locally.

The symptom ("stamps sync, connected apps don't, on a brand-new 2nd device") came from failures on
_both_ halves depending on account type and timing.

## Restore-path map (how a 2nd device gets state)

- **Passkey / Ethereum:** full restore on **first** sign-in only — `restoreAccountFromSwarm` →
  `restoreAccountToStores` (includes connectedApps + identities + stamps). Re-signin is blocked when the
  account already exists locally (`signin/*/+page.svelte`).
- **Agent:** **no restore path at all** — `agent/new` `handleConfirm` just `accountsStore.addAccount(...)`
  (creates fresh). `restoreAccountFromSwarm` is wired only into passkey/ethereum signin. **(open task)**
- **Ongoing refresh** (already-known account): only `refreshAccountFromSwarm`, called from the Devices
  tab. **Used to apply `devices` only** — now applies the full snapshot (Defect A, fixed below).

## Key findings (so we don't re-learn them)

- **Publish works** when the app is pointed at a reachable bee and has a usable stamp — verified via
  Playwright (`Updating feed / Verified root chunk`) on both mutable and immutable batches.
- **Gateway-default gotcha:** `DEFAULT_BEE_NODE_URL` is the public gateway. A cleared-localStorage
  context (e.g. a fresh test profile) publishes to the gateway, which lacks local batches → `400 invalid
batch id`. Earlier "publish is silently skipped" diagnoses were this misconfiguration, not the real
  bug.
- **Partition gate skip is misleading:** in `sync-account.ts`, when the partition-lock SOC write fails
  for _any_ reason it logs `Skipping sync … all partitions are held by other devices` even when the real
  cause is a stamp/SOC error. Worth fixing the message. **(open task)**
- **`/dev` bought immutable batches** (bee's `POST /stamps` default) but the partition scheme needs
  mutable (the partition-lock SOC is rewritten on refresh). Fixed below.
- **Existing cross-context listener mechanism:** `VersionedStorageManager.subscribe(cb)`
  (`lib/src/utils/versioned-storage.ts:152`) wraps a per-key `window 'storage'` listener. The **proxy
  already subscribes to all four stores** (`swarm-id-proxy.ts:302-329`) for auth/connection-info, but
  does **not** publish. In swarm-ui only `accounts.svelte.ts` has a (raw) listener.
- **Publish never writes** connectedApps/identities (it reads them); it writes only the Swarm feed and
  postage-stamp _utilization_. This is what makes a sync-on-change listener loop-safe for
  connectedApps/identities but not for postage-stamps.

## Done

- **Part A — optimistic verify-retry** (`lib/src/sync/sync-account.ts`): after writing the feed, re-read
  it; if a peer overwrote us, re-merge from the latest remote and re-write (bounded, jittered). Closes
  the cross-device lost-update on the shared feed. Reuses `mergeSnapshotWithRemote` (union arrays,
  local-wins scalars). Tested in `sync-account.test.ts`.
- **`/dev` mutable batches** (`swarm-ui/.../dev/+page.svelte` `buyStamp`): sends `immutable: false`.
- **Defect A — full-snapshot refresh** (`refresh-account-from-swarm.ts`): merges
  connectedApps/identities/stamps (not just devices) into the stores via new no-sync `applyRefreshed`
  methods, then keeps publishing untouched. Verified by Playwright (wipe apps → Devices-tab refresh →
  apps restored).
- **Reverted** the fragile connect-popup await-publish; **kept** the connected-apps store hardening
  (`saveConnectedApps` derives the sync account from `identityId`, not `currentIdentityId`).
- **Defect B — cross-context publish**: `connected-apps`/`identities` stores use
  `storageManager.subscribe(...)` to reload + `triggerSync` on a cross-context change, so an open
  SwarmUI window publishes a connection made in the transient popup (and the in-memory staleness is
  fixed); `withBatchWriteLock` serializes to one writer. Loop-safe (publish never writes these stores).
- **Revocation propagation (connectedApps)**: union merge couldn't express deletions (revoke→remove was
  re-added by the merge). Now connectedApps merge is **last-writer-wins by `updatedAt`** with
  **tombstones** (`revokedAt`): revoke keeps a tombstone (cleared session) that propagates, hides from
  the UI (`getActiveAppsByIdentityId`), and won't authenticate. Verified by unit + e2e tests. NOTE:
  identities/postageStamps still can't propagate deletions (same gap, deferred).
- `stamperDepth` cleanup in the proxy (derive depth at construction).

## In progress

- **Defect B — publish from a persistent context.** The connect popup is transient (`window.close()`
  before its debounced sync). Add `storageManager.subscribe(...)` in the **connectedApps** and
  **identities** stores: on a cross-context change, reload the in-memory `$state` (fixes the device-1
  "had to refresh" staleness) and `triggerSync` the affected account(s). A persistent SwarmUI window
  thus publishes a connection made in the popup; `withBatchWriteLock` serializes so only one writer
  uploads. Accounts stays reload-only (avoid clobber); postage-stamps is excluded from the sync trigger
  (utilization writes would loop between two windows).

## Remaining tasks (after Defect B)

1. **Agent restore path.** Give agent accounts a restore-from-Swarm path (mirror passkey/ethereum
   signin) or an explicit agent sign-in, so a 2nd agent device pulls published state. Today it creates a
   fresh local account and never restores.
2. **Publish reliably when no SwarmUI window is open.** Defect B relies on an open SwarmUI tab. In
   production the user is on the dApp, not SwarmUI — the only guaranteed-persistent context is the
   **proxy iframe**, which already subscribes to all stores. Have the proxy publish account state on a
   connection change (build `createSyncAccount` store adapters over the storage managers, or extract a
   shared writer — see the `BatchWriteCoordinator` design). This is the robust, universal fix.
3. **Broaden refresh triggers.** Call `refreshAccountFromSwarm` on app load / account switch, not just
   the Devices tab, so already-known devices stay current without visiting that tab. (Consider applying
   the full snapshot there too.)
4. **Fix the misleading "all partitions are held by other devices" log** in `sync-account.ts` — only say
   that on genuine contention; surface stamp/SOC errors distinctly.
5. **`BatchWriteCoordinator` refactor** (original motivation): extract the proxy's partition-lease /
   stamp / write-lock orchestration into a shared unit so the proxy and `sync-account` share one
   implementation instead of the current duplication. See `BatchWriteCoordinator-Design.md` (note: its
   premises are partially stale — `PartitionLease`, `batch-write-lock`, and `sync-account`'s own
   acquisition already exist).
6. **Per-field / per-item conflict resolution** (optional): same-scalar (account name) and same-item
   (rename one identity) concurrent edits remain last-writer-wins; add per-field timestamps if needed.
7. **Diagnostic test** `swarm-ui/tests/multi-device-connect-sync.test.ts` is local-only (hardcoded local
   batch/signer/seed, injects localStorage, requires the dev cluster). Keep as a manual diagnostic or
   harden into a proper fixture before treating it as CI.

## Environment notes for reproducing

- Local cluster per `.claude/rules/bee-cluster.md`. The app must point at the local bee
  (`http://localhost:1633`) via Network Settings, not the gateway default.
- Use a **mutable** usable batch; node-bought batches (`POST /stamps`) are owned by the node wallet
  (Queen key `566058…`, address `0x26234a…`), so client-side stamping must use that signer (the `/dev`
  "Assign stamp" custom-signer field, or `KNOWN_SIGNERS`).
- Agent accounts (seed phrase) avoid WebAuthn and are the easiest to drive in Playwright.
