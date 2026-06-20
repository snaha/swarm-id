// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { browser } from '$app/environment'
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import { UtilizationAwareStamper, UtilizationStoreDB, type PostageStamp } from '@snaha/swarm-id'
import { accountsStore } from './accounts.svelte'

// ============================================================================
// Postage-stamp runtime view
//
// Stamp DATA is owned by the nested account (`accountsStore`); this module is the
// batchID-keyed RUNTIME over it: locate a stamp across accounts, build a
// utilization-aware stamper, and record volatile utilization. It satisfies the
// lib `PostageStampsStoreInterface` consumed by `createSyncAccount`.
// ============================================================================

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

/** Locate a stamp by batchID across all accounts, with its owning account id. */
function findStamp(batchID: BatchId): { stamp: PostageStamp; accountId: EthAddress } | undefined {
  for (const account of accountsStore.accounts) {
    const stamp = account.postageStamps.find((s) => s.batchID.equals(batchID))
    if (stamp) return { stamp, accountId: account.id }
  }
  return undefined
}

export const postageStampsStore = {
  getStamp(batchID: BatchId): PostageStamp | undefined {
    return findStamp(batchID)?.stamp
  },

  async getStamper(
    batchID: BatchId,
    options: { owner: EthAddress; encryptionKey: Uint8Array },
  ): Promise<UtilizationAwareStamper | undefined> {
    const found = findStamp(batchID)
    if (!found) return undefined

    return UtilizationAwareStamper.create(
      found.stamp.signerKey.toUint8Array(),
      found.stamp.batchID,
      found.stamp.depth,
      getUtilizationStore(),
      options.owner,
      options.encryptionKey,
    )
  },

  updateStampUtilization(batchID: BatchId, newUtilization: number) {
    const found = findStamp(batchID)
    if (!found) {
      console.warn('[PostageStamps] Cannot update utilization: stamp not found')
      return
    }
    accountsStore.updateStampUtilization(found.accountId, batchID, newUtilization)
  },
}
