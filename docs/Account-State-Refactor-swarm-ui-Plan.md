# Phase 0 (swarm-ui) — collapse identity into account in the UI

Branch: `feat/nested-account-model`. The **lib** half is done and committed green
(`028b03b6`); see `docs/Account-State-Refactor-Implementation-Log.md`. This plan covers the
**swarm-ui** half (plan commits 4–5): make the UI single-level — the identity tier disappears, the
account is the only entity the user sees and the thing apps connect to.

## Decisions (from this round)

- **Stamps**: account has ONE **default** stamp (buy/replace/show, account-scoped). Defer the
  multi-batch list + per-app override UI to a later phase (lib/proxy already support overrides).
- **Stateless**: no persistent "current account". Home lists accounts; connect shows an account chooser
  (recently-used-with-this-app first), mirroring today's identity chooser.
- **Routes**: rename `identity/[id]` → `account/[id]` keeping the **Apps | Stamps | Settings** tabs.
- (Earlier) account key model: `account.id` is the app-facing address; app secret =
  `deriveSecret(master, appOrigin)` (no `deriveIdentityKey`); account private key is first-party only.

## Wire-protocol note (avoid re-touching lib)

The popup→iframe `setSecret` `AuthData` keeps its field names `identityId/identityName/identityAddress/
identityPublicKey` — they now carry the **account's** id/name/address/publicKey. The proxy already reads
these into `ConnectionInfo.identity` (sourced from the account). So the UI fills them from the account;
no further lib/proxy change.

---

## Step 0 — persist this plan + establish a baseline

- Save this plan to `docs/Account-State-Refactor-swarm-ui-Plan.md` so it's durable alongside the design
  doc + implementation log.
- **Fix the existing `svelte-check` errors FIRST** (compiler-driven), before any route redesign. Re-run
  `pnpm build:lib && pnpm --filter swarm-identity check` and work the list down to zero. The errors are
  concentrated in the data layer (stores/utils/components) and map directly onto Commit 4 below; fixing
  them yields a compiling baseline. Only then take on the route/redesign churn in Commit 5.

## Commit 4 — stores & data utils (the account aggregate) — fixes the current errors

Make **`stores/accounts.svelte.ts`** the single aggregate owner of the nested account (completing the
#332 `SyncedAccount` idea, folded onto the store for simplicity). It already holds `Account[]` and
persists; add account-scoped CRUD that mutates the nested doc + persists (+ `triggerSync`):

- apps: `getApps(accountId)`, `getActiveApps(accountId)`, `addOrUpdateApp(accountId, appData, sessionMs)`,
  `disconnectApp(accountId, appUrl)`, `revokeApp(accountId, appUrl)`, `removeApp(accountId, appUrl)`,
  `getValidConnection(accountId, appUrl)`, `getRecentApps()` (across accounts, for connect ordering).
- stamps: `getStamps(accountId)`, `addStamp(accountId, stamp)`, `removeStamp(accountId, batchID)`,
  `setDefaultStamp(accountId, batchID)` (exists), plus the runtime `getStamper` / `updateStampUtilization`.
- settings: `setSessionDuration(accountId, ms)` (was `identity.settings.appSessionDuration`).

Port the real logic from the old `connected-apps.svelte.ts` (LWW `updatedAt`, `revokedAt` tombstone,
`connectedUntil` validity, reconnect clears `revokedAt`) and `postage-stamps.svelte.ts` (dedupe by
batchID, `getStamper` building `UtilizationAwareStamper` + IndexedDB utilization, `updateStampUtilization`
skip-sync). The **stamper/utilization runtime** (IndexedDB-backed) stays as a small helper module; only
the stamp DATA moves under the account.

Then:

- **Delete `stores/identities.svelte.ts`**. Reduce `connected-apps.svelte.ts` / `postage-stamps.svelte.ts`
  to thin re-exports over `accountsStore` (or delete and repoint imports — compiler-driven).
- **`utils/restore-account.ts`**: build ONE nested `Account` (apps + stamps inline) and `addAccount`;
  drop the four-store fan-out.
- **`utils/refresh-account-from-swarm.ts`**: import the lib merge primitives now exported from
  `@snaha/swarm-id` (`mergeConnectedApps`, `mergePostageStamps`, `mergeDevicesList`) instead of the local
  duplicates; apply via a single `accountsStore.applyRefreshed(accountId, { connectedApps, postageStamps,
devices })`. (This also lands the #337 dedup for the refresh path.)
- **`stores/sync.svelte.ts`**: `createSyncAccount({ bee, accountsStore, postageStampsStore (stamper
helper), utilizationStore, utilizationUploader })` — drop `identitiesStore` / `connectedAppsStore`.
- **`agent-account.ts`** + create flows: construct accounts with `connectedApps: []`, `postageStamps: []`
  (and `publicKey` set from the derived account keypair).
- **`stores/session.svelte.ts`**: drop identity-creation fields (`currentIdentityId`,
  `selectedStampOption`); keep app-connect + import fields.

Target: `pnpm --filter swarm-identity check` advances (UI green comes at end of Commit 5).

## Commit 5 — routes & components (UI green)

- **Routes**: move `routes/(app)/identity/[id]/*` → `routes/(app)/account/[id]/*` (`apps`, `stamps`,
  `stamps/new`, `settings`, `[id]/+layout.svelte` tabs, `[id]/+page.svelte`). Update `lib/routes.ts`
  constants (`IDENTITY_APPS` → `ACCOUNT_APPS`, etc.).
- **Delete** `(create)/identity/new` and `(create)/stamps/identity/new`. Account creation flows
  (`eth/new`, `passkey/new`, `agent/new`, `signin/*`, `import/*`) create the account directly (its own
  keypair); no identity step. Keep `(create)/stamps/account/new` for the synced-account default stamp.
- **`connect/+page.svelte`**: replace the identity chooser with an **account** chooser (recently-used
  first via `getRecentApps`/`getValidConnection`); `appSecret = deriveSecret(master, appOrigin)`; write
  via `accountsStore.addOrUpdateApp(accountId, …)`; `setSecret` AuthData filled from the account.
- **`home/+page.svelte`**: list accounts (repurpose `account-selector.svelte` / `identity-list.svelte`
  into an account list); click → `ACCOUNT_APPS`.
- **`(app)/+layout.svelte` + `components/drawer.svelte`**: header shows account name only; drawer = account
  switcher + account details; remove "create identity".
- **`components/app-list.svelte`**: account-scoped (`accountId`, `app.appUrl`); session duration per
  account.
- **`components/add-postage-stamp.svelte`**: `derivePostageSignerKey(account.derivationKey)` (drop the
  identity arg). On success → `accountsStore.setDefaultStamp(accountId, batchID)`.
- **`account/[id]/stamps`**: account default stamp only — remove the "Account stamp vs Identity stamp"
  badges and the "use separate stamp" flow.

## Verification

- `pnpm check:all` green (covers `@snaha/swarm-id`, `swarm-identity`, `@swarm-id/ui`, demo).
- Manual (`pnpm dev:legacy`, trusted origin `localhost:5510`; restart dev servers after the branch
  switch per the dev-build-watcher note): create an account → it appears on home; connect the demo app →
  account chooser → app connects and uploads with the account default stamp; buy/replace the default
  stamp; rename the account; disconnect/revoke an app.
- Multi-device (per `project_e2e_auth_testing`, `project_stale_tab_multidevice`): two seed-phrase agent
  accounts; create/delete an app + stamp on device A; device B converges on load/account-switch.
  Fully close/reopen tabs to avoid stale HMR lib code.
- After it's green, append a "Phase 0 — swarm-ui" entry to
  `docs/Account-State-Refactor-Implementation-Log.md` and commit.

## Open question surfaced for later (not blocking)

`getConnectedIdentityIds(appUrl)` (old) returned which identities an app was connected to. Its only role
now is connect-ordering ("recently used"); folded into `getRecentApps`. No behavior lost.
