// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deleting an account, everything after the unlock: dilute its drives, tell
 * its other devices, then drop the record. The dialog owns the screens; this
 * owns the order (docs/Account-State.md, "Account deletion").
 */
import { type SyncResult, isScratchDrive, stampRefusal } from '@snaha/swarm-id/internal'

import { prefix0x } from '$lib/crypto/hex'
import { syncStore } from '$lib/dev/sync.svelte'
import {
  type DilutionProgress,
  type RequestFunding,
  runDeleteDilution,
} from '$lib/payment/drive-operation'
import { derivePostageSigner } from '$lib/payment/purchase'
import { accountBusStore } from '$lib/stores/account-bus'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { sessionStore } from '$lib/stores/session.svelte'
import type { Account } from '$lib/types'

export type DeletionProgress = DilutionProgress | { step: 'publishing' }

/**
 * - `unfunded`: the gas payment was declined, so nothing was sent and nothing
 *   torn down; the caller asks whether to delete without diluting.
 * - `partial`: deleted without diluting, so the user gets the postage signer
 *   key that still owns the drives.
 */
export type DeletionResult =
  | { status: 'deleted' }
  | { status: 'unfunded' }
  | { status: 'partial'; signerPrivateKey: string }

export interface DeleteAccountOptions {
  account: Account
  /** Batch ids (hex) of the drives whose data the user chose to keep. */
  keep: ReadonlySet<string>
  requestFunding: RequestFunding
  /** The user already declined the gas and chose to delete anyway. */
  undiluted?: boolean
  /** Throws once the caller has moved on; run before the first spend and the teardown. */
  checkpoint: () => void | Promise<void>
  onProgress?: (progress: DeletionProgress) => void
}

/**
 * Delete `account` from every device. Throws, leaving the account in place,
 * when a dilution or the publish failed; running it again is safe, since a
 * diluted drive plans as `expires-soon`.
 */
export async function deleteAccount(options: DeleteAccountOptions): Promise<DeletionResult> {
  const { account, keep, requestFunding, undiluted = false, checkpoint, onProgress } = options
  // Derived up front: once the record is gone there is nothing to derive it from.
  const { signerKey } = await derivePostageSigner(account.derivationKey)

  if (!account.isLocal && !undiluted) {
    const dilution = await runDeleteDilution({
      account,
      signerKey,
      keep,
      requestFunding,
      beforeSpend: checkpoint,
      onProgress,
    })
    if (dilution.status === 'failed') {
      throw new Error('Some drives could not be prepared for deletion.')
    }
    if (dilution.status === 'unfunded') {
      return { status: 'unfunded' }
    }
  }

  await checkpoint()
  onProgress?.({ step: 'publishing' })
  await tearDownAccount(account)
  return undiluted
    ? { status: 'partial', signerPrivateKey: prefix0x(signerKey.toHex()) }
    : { status: 'deleted' }
}

/**
 * Whether the account's default drive can still carry a feed write. Without
 * one no device can read the account from Swarm anyway, so the deletion goes
 * out on the bus alone.
 */
export function canPublishToSwarm(account: Account): boolean {
  const id = account.defaultPostageStampBatchID
  const drive = id && account.stamps.find((stamp) => stamp.batchID.equals(id))
  return !!drive && !isScratchDrive(drive) && stampRefusal(drive) === undefined
}

/**
 * Mark the account deleted, publish that, then remove it from this device.
 * The record is what publishes the marker, so it goes only once the feed
 * write has landed; a failed publish takes the marker back and throws. Apps
 * are revoked only after that, so a failed attempt leaves them connected.
 */
export async function tearDownAccount(account: Account): Promise<void> {
  if (!account.isLocal) {
    account.markDeleted()
    if (canPublishToSwarm(account)) {
      await publishToSwarm(account)
    }
    account.revokeAllApps()
    // The bus goes last: live peers forget the account the moment it lands.
    await accountBusStore.publishBeforeClose(account.toSyncedRecord())
  }
  accountsStore.remove(account.id)
  if (sessionStore.currentAccountId === account.id.toHex()) {
    sessionStore.clearCurrentAccount()
  }
}

async function publishToSwarm(account: Account): Promise<void> {
  let published: SyncResult | undefined
  try {
    published = await syncStore.syncAccount(account.id.toHex())
  } finally {
    if (!published || published.status === 'error') {
      account.cancelDeletion()
    }
  }
  if (!published) {
    throw new Error('The deletion could not be published to your other devices.')
  }
  if (published.status === 'error') {
    throw new Error(`The deletion could not be published: ${published.error}`)
  }
  if (!account.deleted) {
    // Taken back mid-publish by another tab loading, so what went out is unknown.
    throw new Error('The deletion was interrupted.')
  }
}
