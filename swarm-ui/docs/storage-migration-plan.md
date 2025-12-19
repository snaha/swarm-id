# Plan: Move Storage/Serialization Logic from swarm-ui to lib

**Status:** Planned (not yet implemented)
**Created:** 2025-12-19

## Goal
Move storage and serialization logic from `swarm-ui/src/lib/stores/` to `@swarm-id/lib` so it can be reused by other UIs and demos. The lib will own schemas, types, and localStorage operations while swarm-ui keeps the Svelte 5 reactive wrappers.

## Design Decisions
- **Function-based API** - Export functions like `loadAccounts()`, `saveAccounts()`, etc.
- **Direct localStorage** - Use `typeof window !== 'undefined'` check, no adapter pattern
- **Keep session store in swarm-ui** - It's UI/auth-flow specific

## New lib File Structure

```
lib/src/
├── storage/
│   ├── index.ts           # All storage exports
│   ├── schemas.ts         # Zod schemas + type definitions
│   ├── constants.ts       # Storage keys, versions
│   ├── accounts.ts        # Account load/save functions
│   ├── identities.ts      # Identity load/save functions
│   ├── connected-apps.ts  # ConnectedApp load/save functions
│   └── postage-stamps.ts  # PostageStamp load/save functions
└── index.ts               # Update to re-export storage
```

## Files to Create in lib

### 1. `lib/src/storage/constants.ts`
```typescript
export const STORAGE_KEYS = {
  ACCOUNTS: 'swarm-accounts',
  IDENTITIES: 'swarm-identities',
  CONNECTED_APPS: 'swarm-connected-apps',
  POSTAGE_STAMPS: 'swarm-postage-stamps',
}
export const STORAGE_VERSIONS = { ACCOUNTS: 1, IDENTITIES: 1, ... }
```

### 2. `lib/src/storage/schemas.ts`
Consolidate schemas from `swarm-ui/src/lib/schemas.ts` plus store schemas:
- EthAddressSchema, BatchIdSchema, HexStringSchema (with bee-js transforms)
- TimestampSchema, UrlSchema, VersionedStorageSchema
- AccountSchemaV1, IdentitySchemaV1, ConnectedAppSchemaV1, PostageStampSchemaV1, AppDataSchema
- All type exports: Account, Identity, ConnectedApp, PostageStamp, AppData

### 3. `lib/src/storage/accounts.ts`
```typescript
export function loadAccounts(): Account[]
export function saveAccounts(data: Account[]): void
export function serializeAccount(account: Account): Record<string, unknown>
export function clearAccounts(): void
export function findAccount(accounts: Account[], id: string | Bytes): Account | undefined
```

### 4. `lib/src/storage/identities.ts`
```typescript
export function loadIdentities(): Identity[]
export function saveIdentities(data: Identity[]): void
export function serializeIdentity(identity: Identity): Record<string, unknown>
export function clearIdentities(): void
export function findIdentity(identities: Identity[], id: string): Identity | undefined
export function filterIdentitiesByAccount(identities: Identity[], accountId: string | Bytes): Identity[]
```

### 5. `lib/src/storage/connected-apps.ts`
```typescript
export function loadConnectedApps(): ConnectedApp[]
export function saveConnectedApps(data: ConnectedApp[]): void
export function clearConnectedApps(): void
export function findConnectedApp(apps: ConnectedApp[], appUrl: string): ConnectedApp | undefined
export function filterAppsByIdentity(apps: ConnectedApp[], identityId: string): ConnectedApp[]
export function getConnectedIdentityIds(apps: ConnectedApp[], appUrl: string): string[]
```

### 6. `lib/src/storage/postage-stamps.ts`
```typescript
export function loadPostageStamps(): PostageStamp[]
export function savePostageStamps(data: PostageStamp[]): void
export function serializePostageStamp(stamp: PostageStamp): Record<string, unknown>
export function clearPostageStamps(): void
export function findPostageStamp(stamps: PostageStamp[], batchID: string | Bytes): PostageStamp | undefined
export function filterStampsByIdentity(stamps: PostageStamp[], identityId: string): PostageStamp[]
```

### 7. `lib/src/storage/index.ts`
Re-export all schemas, types, and functions

## Files to Modify in lib

### 8. `lib/package.json`
Add `./storage` export:
```json
"exports": {
  ...existing...,
  "./storage": {
    "import": "./dist/storage/index.js",
    "types": "./dist/storage/index.d.ts"
  }
}
```

### 9. `lib/rollup.config.js`
Add storage module build entry

### 10. `lib/src/index.ts`
Add: `export * from './storage'`

## Files to Update in swarm-ui

### 11. `swarm-ui/src/lib/stores/accounts.svelte.ts`
Wrap lib functions with Svelte reactivity:
```typescript
import { loadAccounts, saveAccounts, clearAccounts, findAccount, type Account } from '@swarm-id/lib/storage'

let accounts = $state<Account[]>(loadAccounts())

export const accountsStore = {
  get accounts() { return accounts },
  addAccount(account) { accounts = [...accounts, account]; saveAccounts(accounts); return account },
  ...
}
```

### 12-14. Similarly update identities, connected-apps, postage-stamps stores

### 15. `swarm-ui/src/lib/types.ts`
Update to re-export from lib:
```typescript
export type { Account, Identity, ConnectedApp, PostageStamp, AppData } from '@swarm-id/lib/storage'
```

### 16. Delete `swarm-ui/src/lib/schemas.ts`
(Moved to lib)

## Migration Steps

1. Create `lib/src/storage/` directory structure
2. Create `constants.ts` and `schemas.ts` in lib
3. Create storage function files (accounts, identities, connected-apps, postage-stamps)
4. Create `lib/src/storage/index.ts` with all exports
5. Update `lib/package.json` exports
6. Update `lib/rollup.config.js` build
7. Update `lib/src/index.ts` to re-export storage
8. Build lib: `cd lib && pnpm build`
9. Update swarm-ui stores to use lib functions
10. Update swarm-ui types.ts to re-export from lib
11. Delete swarm-ui schemas.ts
12. Run `cd swarm-ui && pnpm check:all`

## Critical Files Summary

**Create in lib:**
- `lib/src/storage/constants.ts`
- `lib/src/storage/schemas.ts`
- `lib/src/storage/accounts.ts`
- `lib/src/storage/identities.ts`
- `lib/src/storage/connected-apps.ts`
- `lib/src/storage/postage-stamps.ts`
- `lib/src/storage/index.ts`

**Modify in lib:**
- `lib/package.json`
- `lib/rollup.config.js`
- `lib/src/index.ts`

**Modify in swarm-ui:**
- `swarm-ui/src/lib/stores/accounts.svelte.ts`
- `swarm-ui/src/lib/stores/identities.svelte.ts`
- `swarm-ui/src/lib/stores/connected-apps.svelte.ts`
- `swarm-ui/src/lib/stores/postage-stamps.svelte.ts`
- `swarm-ui/src/lib/types.ts`

**Delete from swarm-ui:**
- `swarm-ui/src/lib/schemas.ts`

## Responsibility Split

| Concern | Owner |
|---------|-------|
| Zod schemas & types | lib |
| Serialization (Bytes→hex) | lib |
| localStorage load/save | lib |
| Versioning/migration | lib |
| Svelte 5 reactivity | swarm-ui |
| Session store | swarm-ui |
| Layout store | swarm-ui |
