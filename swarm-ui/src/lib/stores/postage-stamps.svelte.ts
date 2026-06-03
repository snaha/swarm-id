// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  createPostageStampsStorageManager,
  type PostageStamp,
  UtilizationAwareStamper,
  UtilizationStoreDB,
} from '@snaha/swarm-id'
import { triggerSync } from '$lib/utils/sync-hooks'

// ============================================================================
// Storage Manager
// ============================================================================

const storageManager = createPostageStampsStorageManager()

// Lazy utilization store initialization (browser only)
let utilizationStore: UtilizationStoreDB | undefined

const getUtilizationStore = () => {
  if (!browser) {
    throw new Error('Utilization store not available (browser only)')
  }

  if (!utilizationStore) {
    utilizationStore = new UtilizationStoreDB()
  }

  return utilizationStore
}

function loadPostageStamps(): PostageStamp[] {
  if (!browser) return []
  return storageManager.load()
}

function savePostageStamps(data: PostageStamp[], skipSync = false, accountId?: string): void {
  storageManager.save(data)

  // Trigger Swarm sync (unless explicitly skipped)
  if (!skipSync && accountId) {
    triggerSync(accountId)
  }
}

// ============================================================================
// Reactive Store
// ============================================================================

let postageStamps = $state<PostageStamp[]>(loadPostageStamps())

export const postageStampsStore = {
  get stamps() {
    return postageStamps
  },

  addStamp(stamp: Omit<PostageStamp, 'createdAt'>, accountId: string): PostageStamp {
    // Check for duplicate batch ID
    const existingStamp = postageStamps.find((s) => s.batchID.equals(stamp.batchID))
    if (existingStamp) {
      throw new Error(`Postage stamp with batch ID ${stamp.batchID.toHex()} already exists`)
    }

    const newStamp: PostageStamp = {
      ...stamp,
      createdAt: Date.now(),
    }
    postageStamps = [...postageStamps, newStamp]
    savePostageStamps(postageStamps, false, accountId)
    return newStamp
  },

  removeStamp(batchID: BatchId, accountId: string) {
    postageStamps = postageStamps.filter((s) => !s.batchID.equals(batchID))
    savePostageStamps(postageStamps, false, accountId)
  },

  getStamp(batchID: BatchId): PostageStamp | undefined {
    return postageStamps.find((s) => s.batchID.equals(batchID))
  },

  async getStamper(
    batchID: BatchId,
    options: { owner: EthAddress; encryptionKey: Uint8Array },
  ): Promise<UtilizationAwareStamper | undefined> {
    const stamp = this.getStamp(batchID)
    if (!stamp) {
      return undefined
    }

    // Get utilization store
    const cache = getUtilizationStore()

    // Create utilization-aware stamper with loaded bucket state
    const stamper = await UtilizationAwareStamper.create(
      stamp.signerKey.toUint8Array(),
      stamp.batchID,
      stamp.depth,
      cache,
      options.owner,
      options.encryptionKey,
    )

    return stamper
  },

  updateStampUtilization(batchID: BatchId, newUtilization: number) {
    const stamp = postageStamps.find((s) => s.batchID.equals(batchID))
    if (!stamp) {
      console.warn('[PostageStamps] Cannot update utilization: stamp not found')
      return
    }

    // Update utilization
    stamp.utilization = newUtilization

    // Save without triggering sync (to avoid infinite loop)
    savePostageStamps(postageStamps, true)
  },

  /**
   * Upsert stamps pulled from a Swarm refresh (by batchID), WITHOUT firing
   * `triggerSync` — refresh data shouldn't be re-published. Stamps for other
   * accounts are left untouched.
   */
  applyRefreshed(refreshedStamps: PostageStamp[]) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral upsert map
    const byId = new Map(postageStamps.map((s) => [s.batchID.toHex(), s]))
    for (const s of refreshedStamps) {
      byId.set(s.batchID.toHex(), s)
    }
    postageStamps = [...byId.values()]
    savePostageStamps(postageStamps, true)
  },

  clear() {
    postageStamps = []
    storageManager.clear()
  },
}
