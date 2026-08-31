// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What an `account-delta` carries, and what it deliberately does not.
 *
 * The two halves live together because they are one rule read forwards and
 * backwards: the publisher omits the per-context session fields, so every
 * receiver has to put its own back after the merge.
 */

import { serializeAccountStateSnapshot } from "../utils/account-state-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import { portableConnectedApp } from "../utils/storage-managers"
import type { ConnectedApp } from "../schemas"
import type { AccountDeltaInput } from "./messages"

/**
 * The wire form of an account snapshot: everything except the per-context
 * session material on each connected app.
 *
 * `appSecret` is stripped because the receivers are the account's other live
 * contexts, and one of them is a proxy iframe embedded by an arbitrary dApp
 * page. Handing dApp A's iframe dApp B's secret would give it strictly more
 * than the popup handshake does — `serializeSyncedAccount` strips exactly these
 * two fields for the same reason. `connectedUntil` goes with it: a session
 * deadline is local to the context that established it, and a peer's copy is
 * meaningless (worse, applying it would extend or truncate someone else's
 * session).
 *
 * Stamp signer keys stay. The handshake already ships the whole stamp list, so
 * including them is not new exposure, and a receiver needs them to keep
 * uploading after a stamp change. Narrowing that — one stamp per app rather
 * than the collection — is #578, for both channels at once.
 */
export function accountDeltaSnapshot(
  snapshot: AccountStateSnapshot,
): AccountDeltaInput["snapshot"] {
  const wire = serializeAccountStateSnapshot(snapshot)
  return {
    ...wire,
    connectedApps: (wire.connectedApps as Record<string, unknown>[]).map(
      portableConnectedApp,
    ),
    // Hand-written serialization, so the compiler cannot verify this matches
    // the schema's shape — a mismatched delta is dropped silently on receive.
  } as unknown as AccountDeltaInput["snapshot"]
}

/**
 * Put this context's own session fields back after a merge.
 *
 * `mergeConnectedApps` is last-writer-wins on the whole entry, so a merely
 * newer incoming entry (a rename, an icon change, a reconnect elsewhere)
 * would otherwise carry the wire's stripped `appSecret`/`connectedUntil` and
 * silently log this session out of an app nobody revoked. Local session
 * fields win — unless the incoming entry marks the session as ended: a
 * `revokedAt` tombstone ("Remove"), or a `disconnectedAt` newer than our own
 * `lastConnectedAt` (a plain "Disconnect", which is not a tombstone but is
 * newer than the session we hold). Either way the incoming entry's cleared
 * fields stand and the session ends.
 *
 * Ours WINS over anything incoming, rather than filling a gap. Under the wire
 * contract there is nothing to lose — the incoming entry has neither field —
 * but a session's own credential and deadline are not a peer's to set, so
 * preferring the incoming value would put a forgetful publisher (or anything
 * that reached the room) one message away from replacing them. The receive
 * schema already drops both; this is the same rule stated where it is used.
 */
export function restoreLocalSessionFields(
  merged: ConnectedApp[],
  local: ConnectedApp[],
): ConnectedApp[] {
  const mine = new Map(local.map((app) => [app.appUrl, app]))
  return merged.map((app) => {
    if (app.revokedAt) return app
    const ours = mine.get(app.appUrl)
    if (!ours) return app
    if (
      app.disconnectedAt !== undefined &&
      app.disconnectedAt > ours.lastConnectedAt
    ) {
      return app
    }
    return {
      ...app,
      appSecret: ours.appSecret ?? app.appSecret,
      connectedUntil: ours.connectedUntil ?? app.connectedUntil,
    }
  })
}
