// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Account as AccountRecord } from '@snaha/swarm-id'

/**
 * `Account` is the live, rich aggregate the app works with: a reactive class
 * (its fields are `$state`) whose mutators are methods on the object
 * (`account.addStamp(…)`, `account.rename(…)`). It wraps the shared
 * `@snaha/swarm-id` `Account` record (byte-class fields serialized to hex by
 * the lib storage manager) and is type-only re-exported here so `$lib/types`
 * stays the one type entry point with no runtime cycle.
 *
 * `AccountRecord` (the lib `Account`, + the nested entity types) is the
 * portable, validated DATA the live account is built from / serialized to.
 */
export type { Account } from '$lib/stores/accounts.svelte'

export type {
  Account as AccountRecord,
  AccessMethod,
  PostageStamp,
  ConnectedApp,
  AccountMetadata,
} from '@snaha/swarm-id'

/**
 * The portable part of an account carried by sign-in sync and backup files —
 * everything except this device's unlock secrets.
 */
export type AccountData = Omit<AccountRecord, 'access' | 'encryptedSeed'>
