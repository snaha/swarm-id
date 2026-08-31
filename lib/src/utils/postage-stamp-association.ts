// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchId } from "@ethersphere/bee-js"
import type { ConnectedApp, PostageStamp, SignedInAccount } from "../schemas"

/**
 * Resolve which postage stamp an app should upload with.
 *
 * An app may carry its own batch override (`postageStampBatchID`); otherwise it
 * falls back to the account's default stamp. The account owns the stamp set, so
 * these pointers are the single source of truth.
 *
 * The lookup is existence-checked: a pointer whose stamp is missing (e.g. a
 * removed or replaced batch) is skipped so resolution falls through to the next
 * candidate instead of failing.
 *
 * Paired with `stampsReachableByApp` below, which decides what a partitioned
 * session may HOLD while this decides what it SPENDS — over the same two
 * pointers, and deliberately differing on tombstones: this one skips them (a
 * deleted stamp cannot be spent), that one keeps them (a session learns its
 * stamp is deleted no other way). Change the pointer rule in one and the other
 * has to follow, or a session holds a stamp it cannot resolve, or resolves one
 * it was never handed.
 */
export function resolveStampForApp(
  app: Pick<ConnectedApp, "postageStampBatchID">,
  account: Pick<SignedInAccount, "defaultPostageStampBatchID">,
  stamps: PostageStamp[],
): PostageStamp | undefined {
  const candidates = [
    app.postageStampBatchID,
    account.defaultPostageStampBatchID,
  ]
  for (const batchId of candidates) {
    if (!batchId) continue
    // Skip deleted stamps (tombstones): a deleted default/override must fall
    // through to the next candidate, same as a missing one.
    const stamp = stamps.find((s) => !s.deletedAt && s.batchID.equals(batchId))
    if (stamp) return stamp
  }
  return undefined
}

/**
 * Collect the postage batch ids associated with an account: every stamp it owns
 * plus any default / per-app override pointers, deduplicated.
 */
export function collectAccountStampBatchIds(
  account: Pick<
    SignedInAccount,
    "defaultPostageStampBatchID" | "postageStamps" | "connectedApps"
  >,
): BatchId[] {
  const candidates: (BatchId | undefined)[] = [
    account.defaultPostageStampBatchID,
    // Deleted stamps (tombstones) own no slots — exclude them from partitioning.
    ...account.postageStamps
      .filter((stamp) => !stamp.deletedAt)
      .map((stamp) => stamp.batchID),
    ...account.connectedApps.map((app) => app.postageStampBatchID),
  ]

  const seen = new Set<string>()
  const result: BatchId[] = []
  for (const batchId of candidates) {
    if (!batchId) continue
    const hex = batchId.toHex()
    if (seen.has(hex)) continue
    seen.add(hex)
    result.push(batchId)
  }
  return result
}

/**
 * The stamps a connected app's session can ever reach: the ones its pointers
 * name — its own batch override, and the account default it falls through to.
 *
 * This is what a PARTITIONED session is handed and allowed to keep (#578). It
 * holds its account view in memory, in a context embedded by an arbitrary dApp
 * page, and it can only ever spend the stamp `resolveStampForApp` picks — so
 * the rest of the collection is signer keys it has no use for. Least privilege
 * rather than a broken boundary: an unpartitioned proxy reads the same material
 * out of shared storage, but it does not have to be handed it.
 *
 * BOTH pointers, not just the winner: the default is the fallthrough
 * `resolveStampForApp` takes when the override's stamp is gone, so shipping
 * only the override would turn a recoverable stale pointer into a session that
 * cannot upload at all. Tombstones its pointers still name are kept too — a
 * tombstone is how the session learns the stamp it was spending is deleted.
 */
export function stampsReachableByApp(
  app: Pick<ConnectedApp, "postageStampBatchID">,
  account: Pick<SignedInAccount, "defaultPostageStampBatchID">,
  stamps: PostageStamp[],
): PostageStamp[] {
  const reachable = [
    app.postageStampBatchID,
    account.defaultPostageStampBatchID,
  ]
    .filter((batchId) => batchId !== undefined)
    .map((batchId) => batchId.toHex())
  return stamps.filter((stamp) => reachable.includes(stamp.batchID.toHex()))
}
