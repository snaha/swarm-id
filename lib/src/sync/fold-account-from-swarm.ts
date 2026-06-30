// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read entry point for Phase 3a: reconstruct account state from Swarm by
 * scanning the append-only device roster (discovery) and folding every device's
 * latest state feed. Replaces the single shared-snapshot fetch used by restore
 * / refresh / the proxy.
 */

import { Bee, PrivateKey } from "@ethersphere/bee-js"
import { deriveSwarmEncryptionKey, deriveSecret } from "../utils/key-derivation"
import { readRoster } from "./device-roster"
import {
  readLatestDeviceState,
  foldAccount,
  type DeviceStateSnapshot,
  type FoldedAccount,
} from "./device-state"
import type { Device } from "../schemas"

export interface FoldAccountResult {
  account: FoldedAccount
  devices: Device[]
}

/**
 * Folds in flight, keyed on `accountId:derivationKey`. A full fold is many slow
 * Swarm reads (roster + every device-state feed); the UI triggers it from
 * several uncoordinated places (account layout mount, dev page, restore) that
 * commonly fire together. Coalescing concurrent calls to a single promise
 * collapses that burst into one read set — especially on a slow gateway where a
 * fold takes seconds, so overlapping triggers are the norm. The entry is cleared
 * when the fold settles, so a later fold always re-reads (no stale cache).
 *
 * Coalesced callers share the one in-flight READ but each receives its own
 * deep-cloned `FoldAccountResult` (see `cloneFoldResult`), so a caller that
 * mutates its result can't corrupt the others.
 */
const inFlightFolds = new Map<string, Promise<FoldAccountResult | undefined>>()

/** Per-caller deep copy so coalesced callers can't corrupt each other's result. */
function cloneFoldResult(
  result: FoldAccountResult | undefined,
): FoldAccountResult | undefined {
  return result === undefined ? undefined : structuredClone(result)
}

/**
 * Derive the feed owner + encryption key from the account derivation key, read
 * the roster, fold all device-state feeds. Returns `undefined` when the roster
 * is empty (no device has published — equivalent to today's "no-backup").
 *
 * Concurrent calls for the same account share one in-flight read (see
 * `inFlightFolds`); `bee` is keyed out because any client reads the same feeds.
 */
export async function foldAccountFromSwarm(opts: {
  bee: Bee
  derivationKey: string
  accountId: string
}): Promise<FoldAccountResult | undefined> {
  const key = `${opts.accountId}:${opts.derivationKey}`
  const existing = inFlightFolds.get(key)
  // Clone on the way out (both the coalesced and the originating caller) so the
  // shared in-flight read is reused but no two callers alias the same object.
  if (existing) return existing.then(cloneFoldResult)
  const fold = doFoldAccountFromSwarm(opts).finally(() => {
    inFlightFolds.delete(key)
  })
  inFlightFolds.set(key, fold)
  return fold.then(cloneFoldResult)
}

async function doFoldAccountFromSwarm(opts: {
  bee: Bee
  derivationKey: string
  accountId: string
}): Promise<FoldAccountResult | undefined> {
  const swarmEncryptionKey = await deriveSwarmEncryptionKey(opts.derivationKey)
  const backupKeyHex = await deriveSecret(swarmEncryptionKey, "backup-key")
  const owner = new PrivateKey(backupKeyHex).publicKey().address()

  const devices = await readRoster({
    bee: opts.bee,
    accountId: opts.accountId,
    owner,
  })
  if (devices.length === 0) return undefined

  // Fold the latest view of every non-removed device. Reads run in parallel:
  // each device feed is independent and each lookup is a multi-round-trip epoch
  // traversal, so overlapping them collapses N×latency into ≈1×. A device whose
  // feed is unreachable is skipped (best-effort), not fatal — its peers' views
  // still converge the shared entities.
  // ponytail: plain Promise.all — device count is tiny; add a concurrency pool
  // only if rosters ever grow large.
  const views = (
    await Promise.all(
      devices
        .filter((device) => !device.removedAt)
        .map((device) =>
          readLatestDeviceState({
            bee: opts.bee,
            accountId: opts.accountId,
            deviceId: device.deviceId,
            owner,
          }).catch(() => undefined),
        ),
    )
  ).filter((view): view is DeviceStateSnapshot => view !== undefined)

  // No readable device feed → nothing to restore (the roster exists but every
  // device's state was unreachable). Mirrors the `devices.length === 0` guard
  // above, and guarantees `foldAccount` has a view carrying `accountPublicKey`.
  if (views.length === 0) return undefined

  return { account: foldAccount(views, devices), devices }
}
