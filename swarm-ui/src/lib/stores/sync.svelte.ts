import {
  createSyncAccount,
  type SyncAccountFunction,
  UtilizationStoreDB,
  DebouncedUtilizationUploader,
} from '@swarm-id/lib'
import { identitiesStore } from './identities.svelte'
import { connectedAppsStore } from './connected-apps.svelte'
import { postageStampsStore } from './postage-stamps.svelte'
import { accountsStore } from './accounts.svelte'
import { networkSettingsStore } from './network-settings.svelte'
import { Bee } from '@ethersphere/bee-js'
import { browser } from '$app/environment'

// ============================================================================
// Lazy Initialization (Browser Only)
// ============================================================================

// Lazy Bee client initialization
let bee: Bee | undefined

const getBeeClient = () => {
  if (!browser) return undefined

  if (!bee) {
    const beeApiUrl = networkSettingsStore.beeNodeUrl
    bee = new Bee(beeApiUrl)
  }

  return bee
}

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

// Lazy sync account function initialization
let syncAccountFn: SyncAccountFunction | undefined

const getSyncAccount = () => {
  if (!browser) return undefined

  const beeClient = getBeeClient()
  if (!beeClient) return undefined

  if (!syncAccountFn) {
    syncAccountFn = createSyncAccount({
      bee: beeClient,
      accountsStore,
      identitiesStore,
      connectedAppsStore,
      postageStampsStore,
      utilizationStore: getUtilizationStore()!,
      utilizationUploader: getUtilizationUploader()!,
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
  async syncAccount(accountId: string): Promise<void> {
    if (!browser) {
      console.warn('[StateSync] Sync disabled - not in browser')
      return
    }

    const syncAccount = getSyncAccount()
    if (!syncAccount) {
      console.warn('[StateSync] Sync function not available')
      return
    }

    await syncAccount(accountId)
  },
}
