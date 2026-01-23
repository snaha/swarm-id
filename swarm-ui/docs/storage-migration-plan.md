# Storage Migration Plan

**Status:** Partially Implemented - Ready for Final Migration
**Updated:** 2026-01-05

---

## TL;DR - What Needs To Be Done

**Goal:** Make swarm-ui stores use the storage infrastructure that already exists in `@swarm-id/lib` instead of their own duplicate implementations.

**The Problem:**

- `lib/` already has storage managers, serializers, and parsers
- `swarm-ui/` has duplicate implementations that don't use lib
- There are 3 copies of type definitions
- Storage keys are different (`swarm-*` vs `swarm-id-*`)

**The Solution:**

1. Update swarm-ui stores to use lib's storage managers
2. Add storage key migration (old → new)
3. Remove duplicate code from swarm-ui
4. Centralize constants in lib

---

## Implementation Phases

### Phase 1: Migrate swarm-ui Stores to Use lib Storage Managers

**Goal:** Replace custom load/save/serialize/parse functions in each swarm-ui store with lib's `VersionedStorageManager`.

#### Step 1.1: Update accounts.svelte.ts

**File:** `swarm-ui/src/lib/stores/accounts.svelte.ts`

**Before:** Store has its own `loadAccounts()`, `saveAccounts()`, `serializeAccount()`, `parse()` functions.

**After:** Store uses `createAccountsStorageManager()` from lib.

```typescript
// BEFORE (current)
import { VersionedStorageSchema } from '$lib/schemas'
import { type Account, AccountSchemaV1 } from '$lib/types'

const STORAGE_KEY = 'swarm-accounts'
function loadAccounts(): Account[] { ... }
function saveAccounts(data: Account[]): void { ... }

// AFTER (target)
import { createAccountsStorageManager, type StorageAccount } from '@swarm-id/lib'

const storageManager = createAccountsStorageManager()

// Use storageManager.load() and storageManager.save()
```

**Migration Logic Required:**

```typescript
// Check for old key, migrate if found
const OLD_KEY = 'swarm-accounts'
const oldData = localStorage.getItem(OLD_KEY)
if (oldData) {
	// Parse with old format, save with new manager, delete old key
	localStorage.removeItem(OLD_KEY)
}
```

#### Step 1.2: Update identities.svelte.ts

**File:** `swarm-ui/src/lib/stores/identities.svelte.ts`

Same pattern as accounts. Replace custom functions with `createIdentitiesStorageManager()`.

**Old key:** `swarm-identities`
**New key:** `swarm-id-identities`

#### Step 1.3: Update connected-apps.svelte.ts

**File:** `swarm-ui/src/lib/stores/connected-apps.svelte.ts`

Same pattern. Replace with `createConnectedAppsStorageManager()`.

**Old key:** `swarm-connected-apps`
**New key:** `swarm-id-connected-apps`

#### Step 1.4: Update postage-stamps.svelte.ts

**File:** `swarm-ui/src/lib/stores/postage-stamps.svelte.ts`

Same pattern. Replace with `createPostageStampsStorageManager()`.

**Old key:** `swarm-postage-stamps`
**New key:** `swarm-id-postage-stamps`

#### Acceptance Criteria for Phase 1:

- [ ] All 4 stores use lib's storage managers
- [ ] Old localStorage data is migrated to new keys on first load
- [ ] Old keys are removed after migration
- [ ] `pnpm check` passes in swarm-ui
- [ ] Manual test: Create account, refresh, data persists

---

### Phase 2: Centralize Constants in lib

**Goal:** Move time constants and session defaults from swarm-ui to lib.

#### Step 2.1: Add constants to lib

**File to modify:** `lib/src/utils/storage-managers.ts` (or create new `lib/src/constants.ts`)

```typescript
// Time constants
export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

// Session defaults
export const DEFAULT_SESSION_DURATION = 30 * DAY
```

#### Step 2.2: Export from lib/src/index.ts

```typescript
export { DAY, HOUR, MINUTE, SECOND, DEFAULT_SESSION_DURATION } from './utils/storage-managers'
```

#### Step 2.3: Update swarm-ui imports

**Files to update:**

- `swarm-ui/src/lib/types.ts` - Remove `DEFAULT_SESSION_DURATION`, import from lib
- `swarm-ui/src/lib/stores/connected-apps.svelte.ts` - Import `DEFAULT_SESSION_DURATION` from lib
- Any other files importing from `$lib/time`

#### Acceptance Criteria for Phase 2:

- [ ] Constants exported from `@swarm-id/lib`
- [ ] swarm-ui imports constants from lib
- [ ] `pnpm check` passes in both lib and swarm-ui

---

### Phase 3: Consolidate Type Definitions

**Goal:** Remove duplicate type definitions, use lib as single source of truth.

#### Step 3.1: Update swarm-ui/src/lib/types.ts

**Current:** Has Zod schemas with bee-js transforms + type exports
**Target:** Re-exports types from lib only

```typescript
// AFTER - swarm-ui/src/lib/types.ts
export type {
	StorageAccount as Account,
	StorageIdentity as Identity,
	StorageConnectedApp as ConnectedApp,
	StoragePostageStamp as PostageStamp,
} from '@swarm-id/lib'

// Keep AppDataSchema if still needed locally
export { AppDataSchema } from './app-data-schema' // or move to lib
```

#### Step 3.2: Update imports across swarm-ui

Find and replace imports:

- `import { type Account } from '$lib/types'` → works (re-exported)
- `import { AccountSchemaV1 } from '$lib/types'` → remove or import from lib

#### Acceptance Criteria for Phase 3:

- [ ] swarm-ui/src/lib/types.ts only contains re-exports
- [ ] No duplicate Zod schemas in swarm-ui
- [ ] `pnpm check` passes

---

### Phase 4: Cleanup

**Goal:** Remove files that are no longer needed.

#### Step 4.1: Delete swarm-ui/src/lib/schemas.ts

This file contains `EthAddressSchema`, `BatchIdSchema`, etc. These are now in lib.

**Before deleting:** Ensure nothing imports from `$lib/schemas`. Update any remaining imports.

#### Step 4.2: Delete swarm-ui/src/lib/time.ts

Constants moved to lib in Phase 2.

**Before deleting:** Ensure nothing imports from `$lib/time`.

#### Step 4.3: Final verification

```bash
cd swarm-ui
pnpm check:all
```

#### Acceptance Criteria for Phase 4:

- [ ] `swarm-ui/src/lib/schemas.ts` deleted
- [ ] `swarm-ui/src/lib/time.ts` deleted
- [ ] `pnpm check:all` passes
- [ ] No unused imports/exports (run `pnpm knip`)

---

## Key Files Reference

### lib/ (source of truth)

| File                                 | Contains                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `lib/src/types.ts`                   | Plain entity types (`StorageAccount`, etc.)          |
| `lib/src/utils/storage-managers.ts`  | Zod schemas, parsers, serializers, factory functions |
| `lib/src/utils/versioned-storage.ts` | `VersionedStorageManager` class                      |
| `lib/src/index.ts`                   | All exports                                          |

### swarm-ui/ (to be updated)

| File                              | Current           | Target                  |
| --------------------------------- | ----------------- | ----------------------- |
| `stores/accounts.svelte.ts`       | Own load/save     | Use lib storage manager |
| `stores/identities.svelte.ts`     | Own load/save     | Use lib storage manager |
| `stores/connected-apps.svelte.ts` | Own load/save     | Use lib storage manager |
| `stores/postage-stamps.svelte.ts` | Own load/save     | Use lib storage manager |
| `types.ts`                        | Duplicate schemas | Re-exports only         |
| `schemas.ts`                      | Base schemas      | DELETE                  |
| `time.ts`                         | Time constants    | DELETE                  |

---

## Storage Key Migration

**Critical:** Users have existing data with old keys. Migration must happen automatically.

### Migration Strategy

In each store's initialization:

```typescript
function migrateFromOldKey(oldKey: string, storageManager: VersionedStorageManager<T>) {
	if (typeof window === 'undefined') return

	const oldData = localStorage.getItem(oldKey)
	if (!oldData) return

	try {
		// Parse old data (may need old schema)
		const parsed = JSON.parse(oldData)
		// ... validate and convert if needed

		// Save with new manager (uses new key)
		storageManager.save(parsed.data || parsed)

		// Remove old key
		localStorage.removeItem(oldKey)

		console.log(`Migrated ${oldKey} to new storage format`)
	} catch (e) {
		console.error(`Migration failed for ${oldKey}:`, e)
	}
}
```

### Key Mapping

| Old Key                | New Key                   |
| ---------------------- | ------------------------- |
| `swarm-accounts`       | `swarm-id-accounts`       |
| `swarm-identities`     | `swarm-id-identities`     |
| `swarm-connected-apps` | `swarm-id-connected-apps` |
| `swarm-postage-stamps` | `swarm-id-postage-stamps` |

---

## Type Aliases

To maintain backwards compatibility in swarm-ui, use type aliases:

```typescript
// swarm-ui/src/lib/types.ts
import type {
	StorageAccount,
	StorageIdentity,
	StorageConnectedApp,
	StoragePostageStamp,
} from '@swarm-id/lib'

// Alias for backwards compatibility
export type Account = StorageAccount
export type Identity = StorageIdentity
export type ConnectedApp = StorageConnectedApp
export type PostageStamp = StoragePostageStamp
```

---

## Verification Commands

After each phase:

```bash
# In lib/
cd lib
pnpm build
pnpm check:all

# In swarm-ui/
cd swarm-ui
pnpm check:all
pnpm dev  # Manual testing
```

---

## Context: Why This Architecture

The `@swarm-id/lib` serves two audiences:

| Consumer                      | Uses                                   |
| ----------------------------- | -------------------------------------- |
| **External dApps**            | `SwarmIdClient` to connect via iframe  |
| **Trusted Domain (swarm-ui)** | Storage managers, sync, `SwarmIdProxy` |

Storage is for the trusted domain only - external apps never directly access localStorage.
