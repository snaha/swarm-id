// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The /dev tooling and the sync subsystem drive off the same single account
 * store as the product UI. This alias keeps the historical `sharedAccountsStore`
 * name for those call sites; there is no longer a separate shared model.
 */
export { accountsStore as sharedAccountsStore } from '$lib/stores/accounts.svelte'
