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
