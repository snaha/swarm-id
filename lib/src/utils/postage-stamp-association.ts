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
