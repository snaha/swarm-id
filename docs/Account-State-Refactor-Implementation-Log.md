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

**Pending (plan commit 5 — UI green):** the remaining ~70 `svelte-check` errors are all routes/components.
Rename `routes/(app)/identity/[id]/*` → `account/[id]/*` (+ `lib/routes.ts`); rewrite `connect` (account
chooser via `getRecentConnections`, `deriveSecret(master, appOrigin)`, fill `setSecret` from the
account); `home` (account list); `(app)/+layout.svelte` + `drawer` (account switcher, no "create
identity"); `app-list` (account-scoped); `add-postage-stamp` (`derivePostageSignerKey(derivationKey)`);
delete `(create)/identity/new` + `(create)/stamps/identity/new`; update signin/import/create flows + the
`dev` page. Then `pnpm check:all` green.
