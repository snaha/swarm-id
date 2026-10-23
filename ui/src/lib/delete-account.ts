// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deleting an account, everything after the unlock that proves control of it:
 * dilute its drives so they lapse (`runDeleteDilution`), tell its other
 * devices and live dApp sessions it is gone, and only then drop the record.
 * The dialog owns the ceremony and the screens; this owns the order.
 *
 * See docs/Drive-Payment-Flow.md, "Delete account".
 */
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
 * `partial`: the account is gone but its drives were not diluted — the
 * payment for the gas was declined or did not arrive — so the user is handed
 * the postage signer key that still owns them.
 */
export type DeletionResult = { status: 'deleted' } | { status: 'partial'; signerPrivateKey: string }

export interface DeleteAccountOptions {
  account: Account
  /** Batch ids (hex) of the drives whose data the user chose to keep. */
  keep: ReadonlySet<string>
  requestFunding: RequestFunding
  /**
   * Consulted before each step that changes something — the first spend and
   * the teardown — and throws once the caller has moved on (a closed dialog).
   */
  checkpoint: () => void | Promise<void>
  onProgress?: (progress: DeletionProgress) => void
}

/**
 * Delete `account` from every device. Throws, leaving the account in place,
 * when a dilution transaction failed or the deletion could not be published;
 * running it again is safe — diluted drives plan as `expires-soon`, and the
 * publish is a plain re-send.
 */
export async function deleteAccount(options: DeleteAccountOptions): Promise<DeletionResult> {
  const { account, keep, requestFunding, checkpoint, onProgress } = options
  // Before anything is torn down: the drives are owned by this key, and once
  // the record is gone there is nothing left to derive it from.
  const { signerKey } = await derivePostageSigner(account.derivationKey)

  let diluted = true
  if (!account.isLocal) {
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
    diluted = dilution.status === 'complete'
  }

  await checkpoint()
  onProgress?.({ step: 'publishing' })
  await tearDownAccount(account)
  return diluted
    ? { status: 'deleted' }
    : { status: 'partial', signerPrivateKey: prefix0x(signerKey.toHex()) }
}

/**
 * Mark the account deleted, publish that, then remove it from this device.
 *
 * The publish is awaited, not left to the debounced sync hook, because the
 * record is what publishes it: removed first, a failed publish would leave
 * every peer holding a live account this device can no longer delete. On
 * failure the marked record stays and this throws; calling again re-sends.
 * A local account has nothing on Swarm and no drive to publish through, so it
 * is simply removed.
 */
export async function tearDownAccount(account: Account): Promise<void> {
  if (!account.isLocal) {
    if (!account.deleted) {
      account.markDeleted()
    }
    // The bus reaches live sessions now — a partitioned dApp iframe hears of
    // the revoke no other way — and the feed reaches devices that are closed.
    const [published] = await Promise.all([
      syncStore.syncAccount(account.id.toHex()),
      accountBusStore.publishBeforeClose(account.toSyncedRecord()),
    ])
    if (!published) {
      throw new Error('The deletion could not be published to your other devices.')
    }
    if (published.status === 'error') {
      throw new Error(`The deletion could not be published: ${published.error}`)
    }
  }
  accountsStore.remove(account.id)
  if (sessionStore.currentAccountId === account.id.toHex()) {
    sessionStore.clearCurrentAccount()
  }
}
