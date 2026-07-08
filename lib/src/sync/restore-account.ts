// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Restore Account from Swarm
 *
 * When a passkey auth succeeds but no local account exists (e.g. new device),
 * this utility derives the keys needed to find and decrypt the account
 * snapshot stored in Swarm and returns the restored state.
 */

import { Bee, EthAddress, type Bytes } from "@ethersphere/bee-js"
import { deriveAccountDerivationKey } from "../utils/key-derivation"
import { foldAccountFromSwarm } from "./fold-account-from-swarm"
import type { FoldedAccount } from "./device-state"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"

/**
 * Result of a successful account restore from Swarm
 */
export interface RestoreAccountResult {
  snapshot: AccountStateSnapshot
  derivationKey: string
  credentialId: string
}

/**
 * Thrown when the epoch feed contains a snapshot reference but the chunks
 * backing that reference cannot be downloaded — i.e. the backup exists in
 * the feed but the data is not reachable from this Bee endpoint.
 *
 * Distinct from a generic network error so the UI can show a more useful
 * message ("backup found but not retrievable" vs. "could not reach Swarm").
 */
export class SnapshotDataUnavailableError extends Error {
  readonly reference: string
  readonly cause: unknown

  constructor(reference: string, cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : String(cause ?? "unknown")
    super(`Snapshot data unavailable for ref ${reference}: ${message}`)
    this.name = "SnapshotDataUnavailableError"
    this.reference = reference
    this.cause = cause
  }
}

/**
 * Restore account state from Swarm using passkey authentication result
 *
 * @param bee - Bee client instance
 * @param masterKey - Master key from passkey authentication
 * @param ethereumAddress - Account ID (EthAddress) from passkey authentication
 * @param credentialId - Credential ID from passkey authentication
 * @returns Restored account state, or undefined if no backup found in Swarm
 */
export async function restoreAccountFromSwarm(
  bee: Bee,
  masterKey: Bytes,
  ethereumAddress: EthAddress,
  credentialId: string,
): Promise<RestoreAccountResult | undefined> {
  const accountId = ethereumAddress.toHex()

  console.log(`[RestoreAccount] bee.url=${bee.url} accountId=${accountId}`)

  // Phase 3a: fold the per-device state feeds (discovered via the registry)
  // instead of reading a single shared snapshot. `undefined` = no registry yet
  // (nothing published) — today's "no backup".
  const derivationKey = await deriveAccountDerivationKey(masterKey.toHex())
  const folded = await foldAccountFromSwarm({ bee, derivationKey, accountId })
  if (!folded) return undefined

  return {
    snapshot: foldedToSnapshot(accountId, folded.account),
    derivationKey,
    credentialId,
  }
}

/**
 * Project a folded account onto the legacy `AccountStateSnapshot` shape so
 * callers (the identity UI sign-in / import flows) consume it unchanged.
 *
 * `foldAccountFromSwarm` shallow-FREEZES its result arrays (so coalesced
 * concurrent callers can't corrupt each other's shared view). The snapshot
 * outlives that coalescing window and its arrays are commonly mutated in place
 * downstream, so we COPY them here — otherwise a frozen array would escape and a
 * later `push`/`splice` would throw far from the freeze site.
 */
function foldedToSnapshot(
  accountId: string,
  a: FoldedAccount,
): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: Date.now(),
    accountId,
    metadata: {
      accountName: a.accountName,
      defaultPostageStampBatchID: a.defaultPostageStampBatchID?.toHex(),
      publicKey: a.publicKey,
      settings: a.settings,
      accountNameAt: a.accountNameAt,
      defaultStampAt: a.defaultStampAt,
      settingsAt: a.settingsAt,
      createdAt: a.createdAt,
      lastModified: Date.now(),
      devices: [...a.devices],
      partitionCount: a.partitionCount,
    },
    connectedApps: [...a.connectedApps],
    postageStamps: [...a.postageStamps],
  }
}
