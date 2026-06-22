# Account-State Refactor — Implementation Log

Living record of what each phase/commit actually landed for the multi-device account-state refactor
(#337, #338, #339). Design rationale lives in
[`Account-State-Refactor-337-338-339.md`](./Account-State-Refactor-337-338-339.md). Branch:
`feat/nested-account-model`.

## Phase 0 — nested single-level account model

**Commit `028b03b6` — `feat(lib): collapse to nested single-level account model` (lib green).**
Covers the lib half of Phase 0 (commits 1–3 of the plan, landed as one green checkpoint since `lib/` is
one compilation unit). `pnpm --filter @snaha/swarm-id check:all` passes (782 tests).

- **Schema (`lib/src/schemas.ts`)** — removed `IdentitySchemaV1`/`Identity`. `CommonAccountSchemaV1`
  gains `publicKey`, nested `connectedApps[]` + `postageStamps[]`, `settings`, `lastModified`.
  `ConnectedApp` drops `identityId`, adds optional `postageStampBatchID` (per-app override).
  `AccountStateSnapshot` drops `identities`; metadata gains `publicKey` + `settings`.
- **Key hierarchy decision** — the account is its own app-facing identity: `account.id` is the address
  apps connect to; the app-facing key stays a per-app DERIVED key (`deriveSecret(master, appOrigin)`);
  the account private key (mnemonic-equivalent) is first-party only. `deriveIdentityKey` removed;
  `derivePostageSignerKey` dropped its `identityId` param.
- **Storage (`utils/storage-managers.ts`, `types.ts`)** — one nested account document of record; removed
  the identity/connected-app/postage-stamp storage keys + managers + `serializeIdentity` +
  `disconnectApp`. `serializeAccount` now nests apps + stamps.
- **Sync (`sync/merge-snapshot.ts`, `sync-account.ts`, `store-interfaces.ts`)** — `connectedApps` keyed
  by `appUrl`; identity merge removed; per-collection merge primitives exported. Sync reads apps/stamps
  off the account. Dropped the `IdentitiesStoreInterface`/`ConnectedAppsStoreInterface`.
- **Association (`utils/postage-stamp-association.ts`)** — `resolveStampForIdentity` →
  `resolveStampForApp` (per-app override → account default); `collectAccountStampBatchIds(account)`.
- **Proxy (`swarm-id-proxy.ts`)** — collapsed four storage subscriptions to one; new
  `findConnectionForParent()` resolves `{account, app}` from the nested doc; `ConnectionInfo.identity`
  is sourced from the account; disconnect invalidates the app within the account doc.
- **Tests** — fixtures + merge/snapshot/sync/backup/association tests updated to the nested shape.

**Pending (swarm-ui, plan commits 4–5):** fold `identities` store into an account-owned aggregate
(apps/stamps CRUD + `applyRefreshed`); rewire `restore-account` / `refresh-account-from-swarm` /
`sync.svelte.ts` / `agent-account.ts`; remove the `routes/(app)/identity/[id]/*` subtree; rework the
connect / home / create / stamps flows + `add-postage-stamp` / `drawer` / `app-list`. Target:
`pnpm check:all` green. (~55 `svelte-check` errors at the lib-green checkpoint.)

**Commit `7a01467e` — `feat(swarm-ui): account aggregate store + nested restore/refresh (WIP)`.**
swarm-ui data layer (plan commit 4). **Branch does not compile yet** — routes & components (commit 5)
still reference the old identity tier. Decisions for the UI pass: account default stamp only (defer
multi-batch UI), stateless (no persistent "current account"), keep 3 tabs at `/account/[id]`.

- `stores/accounts.svelte.ts` is now the single aggregate: account-scoped CRUD for connected apps (LWW
  `updatedAt` + `revokedAt` tombstone, `connectedUntil` validity), postage stamps, `settings`, and
  `applyRefreshed` — every mutation maps the nested account doc, persists, and triggers sync (except
  refresh/utilization which skip sync). Added `getRecentConnections()` for the connect-popup ordering.
- Deleted `stores/identities.svelte.ts` and `stores/connected-apps.svelte.ts`.
- `stores/postage-stamps.svelte.ts` reduced to a batchID-keyed runtime view over the account
  (`getStamp` searches accounts, `getStamper` builds the `UtilizationAwareStamper`,
  `updateStampUtilization`) — satisfies the lib `PostageStampsStoreInterface` for `createSyncAccount`.
- `utils/restore-account.ts` adds one nested account (resets app sessions); `utils/refresh-account-from-
swarm.ts` merges into the one account reusing the lib primitives `mergeConnectedApps` /
  `mergePostageStamps` / `mergeDevicesList` (kills the duplicated merge rules — #337 for the read path).
- `stores/sync.svelte.ts` passes only `accountsStore` + `postageStampsStore` to `createSyncAccount`.
- `lib`: the snapshot merge primitives are now exported from the `@snaha/swarm-id` barrel.

**Commit `213b3989` — `feat(ui): single-level account UI (collapse identity tier)`.** Plan commit 5 —
the UI. **`pnpm check:all` is green across lib, swarm-ui, `@swarm-id/ui`, and demo.** Phase 0 complete.

swarm-ui:

- Route subtree `routes/(app)/identity/[id]/*` → `account/[id]/*` (Apps | Stamps | Settings tabs);
  `lib/routes.ts` constants renamed (`ACCOUNT`, `ACCOUNT_APPS/STAMPS/STAMPS_NEW/SETTINGS`).
- `home` lists accounts; `connect` picks an **account** (recently-used first via
  `accountsStore.getRecentConnections`), derives the app secret from the account master
  (`deriveSecret(master, appOrigin)`), and fills the `setSecret` `identity*` fields from the account.
- `(app)/+layout.svelte` + `drawer`: account-only header, account switcher, no "create identity";
  delete/sign-out drop the whole nested account (which owns apps + stamps).
- New `account-list` / `create-account-button` replace `identity-list` / `create-identity-button` +
  `account-selector` (deleted); `app-list` and `add-postage-stamp` are account-scoped
  (`derivePostageSignerKey(derivationKey)`).
- Stamps screen: single account default (the identity/"separate stamp" concept removed); `stamps/new`
  and `(create)/stamps/account/new` add the stamp to the account and set it as default.
- Deleted `(create)/identity/new` and `(create)/stamps/identity/new` (+ the now-orphaned
  `docker-name.ts`); the create/signin/import flows build/restore the **nested** account; `dev` page
  account-scoped.

`ui/` (new UI): `connect-handshake.ts` mirrors into the single nested shared-account document (apps +
stamps inline) via `createAccountsStorageManager` instead of the removed flat managers; the app secret
derives from the account master.

## Multi-device partition fixes (concern B, pre-existing `fix/intent-soc-gateway` code)

Surfaced during Phase 0 multi-device testing; not part of the account refactor but fixed to make it
usable. All in `lib/src/sync`.

- **`739405a4` — bucket-fresh liveness grace.** A live partition holder was misread as departed when its
  fresh beacon hadn't propagated cross-device and its retrievable previous-bucket beacon's `leasedUntil`
  had lapsed. Treat a found beacon as live while `leasedUntil > now - INTENT_LIVENESS_GRACE_MS` (one
  epoch) at the three beacon gates (intent-round sweep, `refreshHoldersFromPresence`,
  `foreignBeaconBeatsUs`); lock-SOC lease checks unchanged.
- **`658140fa` — stop dual-acquire when the creator doesn't know its peer.** A device that created the
  account had `knownDevices=1`, so it skipped both the intent round AND the beacon (both rival-gated) →
  claimed its home partition invisibly; a peer that knew it found no beacon and took the same partition.
  Fix: always publish the beacon while holding a K>1 partition (drop the rival gate); add a
  `refreshKnownDeviceIds` hook on `BatchWriteCoordinator.acquire()` implemented by the proxy
  (`refreshDeviceRegistryFromSwarm`, throttled) so a fresh claim sees a peer that signed in after account
  creation. Verified working with 3 accounts.
- **Parked — partition-acquire latency.** Exclusivity is correct but acquiring is slow (multiple full
  intent-round cycles per upload × 12s guard window, amplified by stale devices + gateway 404s). Candidate
  fixes (cap rivals to live devices, sticky single acquire, lower guard defaults) deferred until after the
  account refactor.

## Phase 2 — #338 read/pull triggers (swarm-ui)

- **Agent restore** (`routes/(app)/(create)/agent/new/+page.svelte`): re-entering a seed now (1) reuses
  the account if already local, else (2) `restoreAccountFromSwarm` (credentialId `""`) →
  `restoreAccountToStores` to adopt a 2nd device's published apps/stamps/devices/settings (snapshot name
  wins), else (3) the prior blank create + synced-stamp flow. Errors surface like the passkey sign-in.
- **Refresh on load / account switch** (`routes/(app)/account/[id]/+layout.svelte`): an `$effect` keyed on
  `page.params.id` calls `refreshAccountFromSwarm(id)` once per account so a signed-in device converges on
  a peer's changes without opening the Devices view. Best-effort (no-backup/error ignored).
- Out of scope this pass: the new `ui/` package and Phase 1 (#337 stamp-deletion tombstones).
- `pnpm check:all` green.

### Status

Phase 0 (nested single-level model) **done & green**. Phase 2 (#338) **done & green** (swarm-ui). Still
open: Phase 1 (#337 stamp-deletion tombstones), the parked partition-acquire latency, Phase 3 (per-device
-log CRDT), and the `ui/` package's agent-restore / refresh triggers. Multi-device exclusivity verified
manually with 3 accounts; the Phase 2 convergence walkthrough not yet re-run end-to-end.
