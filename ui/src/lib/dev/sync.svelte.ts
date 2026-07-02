// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { Bee } from '@ethersphere/bee-js'
import {
  DebouncedUtilizationUploader,
  type SyncAccountFunction,
  type SyncResult,
  UtilizationStoreDB,
  createSyncAccount,
} from '@snaha/swarm-id'

import { browser } from '$app/environment'

import { postageStampsStore } from '$lib/dev/postage-stamps.svelte'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

// ============================================================================
// Lazy Initialization (Browser Only)
// ============================================================================

// Lazy utilization store initialization
let utilizationStore: UtilizationStoreDB | undefined

const getUtilizationStore = () => {
  if (!browser) return undefined

  if (!utilizationStore) {
    utilizationStore = new UtilizationStoreDB()
  }

  return utilizationStore
}

// Lazy debounced uploader initialization
let utilizationUploader: DebouncedUtilizationUploader | undefined

const getUtilizationUploader = () => {
  if (!browser) return undefined

  if (!utilizationUploader) {
    utilizationUploader = new DebouncedUtilizationUploader()
  }

  return utilizationUploader
}

// Sync account function — recreated whenever the Bee node URL changes,
// since createSyncAccount closes over a specific Bee client instance.
let syncAccountFn: SyncAccountFunction | undefined
let lastBeeUrl: string | undefined

const getSyncAccount = () => {
  if (!browser) return undefined

  const currentUrl = networkSettingsStore.beeNodeUrl

  if (!syncAccountFn || currentUrl !== lastBeeUrl) {
    const utilStore = getUtilizationStore()
    const utilUploader = getUtilizationUploader()
    if (!utilStore || !utilUploader) return undefined

    lastBeeUrl = currentUrl
    syncAccountFn = createSyncAccount({
      bee: new Bee(currentUrl),
      accountsStore,
      postageStampsStore,
      utilizationStore: utilStore,
      utilizationUploader: utilUploader,
    })
  }

  return syncAccountFn
}

// ============================================================================
// Export Sync Store
// ============================================================================

export const syncStore = {
  /**
   * Trigger sync for an account
   * Called by store hooks when state changes
   */
  async syncAccount(accountId: string): Promise<SyncResult | undefined> {
    if (!browser) {
      console.warn('[StateSync] Sync disabled - not in browser')
      return undefined
    }

    const syncAccount = getSyncAccount()
    if (!syncAccount) {
      console.warn('[StateSync] Sync function not available')
      return undefined
    }

    return syncAccount(accountId)
  },
}
