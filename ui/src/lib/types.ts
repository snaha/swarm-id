// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Account as AccountRecord } from '@snaha/swarm-id'

/**
 * The live, rich account aggregate the app works with: a reactive class whose
 * mutators are methods on the object (`account.rename(…)`), wrapping the shared
 * `@snaha/swarm-id` `Account` record. Re-exported from the store so `$lib/types`
 * is the home for the UI-local account types. The lib's record and entity types
 * (`Account`, `AccessMethod`, `PostageStamp`, …) are imported straight from
 * `@snaha/swarm-id`.
 */
export type { Account } from '$lib/stores/accounts.svelte'

/**
 * The portable part of an account carried by sign-in sync and backup files —
 * everything except this device's unlock secrets.
 */
export type AccountData = Omit<AccountRecord, 'access' | 'encryptedSeed'>
