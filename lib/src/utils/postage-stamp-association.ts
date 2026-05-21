// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchId } from "@ethersphere/bee-js"
import type { Account, Identity, PostageStamp } from "../schemas"

/**
 * Resolve which postage stamp an identity should upload with.
 *
 * An identity may carry its own stamp (for privacy); otherwise it falls back
 * to the account's default stamp. Postage stamps are no longer tagged with an
 * owning account, so these pointer fields are the single source of truth.
 *
 * The lookup is existence-checked: a pointer whose stamp is missing (e.g. a
 * removed or replaced batch) is skipped so resolution falls through to the
 * next candidate instead of failing.
 */
export function resolveStampForIdentity(
  identity: Pick<Identity, "defaultPostageStampBatchID">,
  account: Pick<Account, "defaultPostageStampBatchID">,
  stamps: PostageStamp[],
): PostageStamp | undefined {
  const candidates = [
    identity.defaultPostageStampBatchID,
    account.defaultPostageStampBatchID,
  ]
  for (const batchId of candidates) {
    if (!batchId) continue
    const stamp = stamps.find((s) => s.batchID.equals(batchId))
    if (stamp) return stamp
  }
  return undefined
}

/**
 * Collect the postage batch ids associated with an account: the account's
 * default stamp plus every stamp referenced by one of its identities.
 *
 * The result is deduplicated — an identity may reuse the account's stamp.
 */
export function collectAccountStampBatchIds(
  account: Pick<Account, "defaultPostageStampBatchID">,
  identities: Pick<Identity, "defaultPostageStampBatchID">[],
): BatchId[] {
  const candidates: (BatchId | undefined)[] = [
    account.defaultPostageStampBatchID,
    ...identities.map((identity) => identity.defaultPostageStampBatchID),
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
