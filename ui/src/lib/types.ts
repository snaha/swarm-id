// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { LocalAccount } from '@snaha/swarm-id'

/**
 * The UI's account model IS the shared `@snaha/swarm-id` Zod model — a single,
 * validated source of truth (no parallel hand-rolled interface). The identity
 * UI only ever creates `local` accounts: the discriminated-union member whose
 * BIP-39 entropy is encrypted at rest with a device-local access method
 * (passkey / eth-wallet / password). Byte-typed fields (`id`, `postageStamps`,
 * …) are bee-js classes at runtime and serialize to hex via the lib storage
 * manager.
 */
export type {
  Account,
  LocalAccount,
  AccessMethod,
  PostageStamp,
  ConnectedApp,
  AccountMetadata,
} from '@snaha/swarm-id'

/**
 * The portable part of a local account carried by sign-in sync and backup
 * files — everything except this device's unlock secrets.
 */
export type AccountData = Omit<LocalAccount, 'access' | 'encryptedSeed'>
