// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchId } from "@ethersphere/bee-js"
import type { ConnectedApp, PostageStamp, SignedInAccount } from "../schemas"

type AppGrant = Pick<ConnectedApp, "drives">
type AccountDefault = Pick<SignedInAccount, "defaultPostageStampBatchID">

/** A scratch drive's slots are reused as a ring; a regular drive's never are. */
export function isScratchDrive(stamp: Pick<PostageStamp, "kind">): boolean {
  return stamp.kind === "scratch"
}

/**
 * The batches an app's grant names (#862): the list it was given, or — for an
 * app with no grant — the account default, followed wherever it moves.
 * `"all"` names every batch the account has, including ones added later.
 */
function grantedBatchIds(
  app: AppGrant,
  account: AccountDefault,
): BatchId[] | "all" {
  if (app.drives !== undefined) return app.drives
  const fallback = account.defaultPostageStampBatchID
  return fallback ? [fallback] : []
}

function inGrant(
  stamps: PostageStamp[],
  granted: BatchId[] | "all",
): PostageStamp[] {
  if (granted === "all") return stamps
  return granted.flatMap((batchId) =>
    stamps.filter((stamp) => stamp.batchID.equals(batchId)),
  )
}

/**
 * The app's PRIMARY drive: where a write that names no drive goes (#862).
 *
 * For an app with no grant, or one granted all drives, that is the account
 * default; for a list, its first granted regular drive. A scratch drive is
 * never primary — every write to one names it. The account owns the stamp set,
 * so these pointers are the single source of truth.
 *
 * Derived, not stored: when the primary leaves the grant, the next granted
 * regular drive takes over with nothing to update. Never the account default
 * for a list that does not name it — the app was not given that drive.
 *
 * Deleted stamps (tombstones) are skipped. An EXPIRED stamp deliberately is
 * not: it can be renewed, and moving on would silently charge a drive the user
 * never picked for this app (#745).
 *
 * Paired with `stampsReachableByApp` below, which decides what a partitioned
 * session may HOLD while this decides what it SPENDS — over the same grant,
 * and deliberately differing on tombstones: this one skips them, that one
 * keeps them (a session learns its stamp is deleted no other way).
 */
export function resolveStampForApp(
  app: AppGrant,
  account: AccountDefault,
  stamps: PostageStamp[],
): PostageStamp | undefined {
  const granted = grantedBatchIds(app, account)
  const candidates =
    granted === "all"
      ? inGrant(stamps, grantedBatchIds({}, account))
      : inGrant(stamps, granted)
  return candidates.find((stamp) => !stamp.deletedAt && !isScratchDrive(stamp))
}

/**
 * The stamps a connected app's session can ever reach: the ones its grant
 * names, tombstones included.
 *
 * This is what a PARTITIONED session is handed and allowed to keep (#578). It
 * holds its account view in memory, in a context embedded by an arbitrary dApp
 * page, so the rest of the collection is signer keys it has no use for. Least
 * privilege rather than a broken boundary: an unpartitioned proxy reads the
 * same material out of shared storage, but it does not have to be handed it.
 *
 * Tombstones its grant still names are kept — a tombstone is how the session
 * learns the stamp it was spending is deleted.
 */
export function stampsReachableByApp(
  app: AppGrant,
  account: AccountDefault,
  stamps: PostageStamp[],
): PostageStamp[] {
  return inGrant(stamps, grantedBatchIds(app, account))
}
