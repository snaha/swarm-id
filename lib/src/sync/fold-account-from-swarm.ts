// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read entry point for Phase 3a: reconstruct account state from Swarm by
 * scanning the append-only device roster (discovery) and folding every device's
 * latest state feed. Replaces the single shared-snapshot fetch used by restore
 * / refresh / the proxy.
 */

import { Bee, EthAddress, PrivateKey } from "@ethersphere/bee-js"
import { deriveSwarmEncryptionKey, deriveSecret } from "../utils/key-derivation"
import { readRoster } from "./device-roster"
import {
  readLatestDeviceState,
  foldAccount,
  type DeviceStateSnapshot,
  type FoldedAccount,
} from "./device-state"
import type { SyncedAccount, Device } from "../schemas"

export interface FoldAccountResult {
  account: FoldedAccount
  devices: Device[]
}

/**
 * Project a folded account onto the `SyncedAccount` record — the single place
 * the field list lives so a new `SyncedAccount`/`FoldedAccount` field can't
 * be silently dropped by a hand-written copy on the sign-in path. `id` and
 * `derivationKey` aren't in the fold (they come from the recovering wallet), so
 * the caller supplies them.
 *
 * `foldAccountFromSwarm` shallow-FREEZES its result arrays so coalesced callers
 * can't corrupt each other's shared view; a persisted `SyncedAccount` outlives
 * that window and is mutated in place downstream, so the arrays are COPIED here.
 */
export function foldedToSyncedAccount(opts: {
  id: EthAddress
  derivationKey: string
  account: FoldedAccount
  lastModified?: number
}): SyncedAccount {
  const { id, derivationKey, account } = opts
  return {
    id,
    name: account.accountName,
    publicKey: account.publicKey,
    createdAt: account.createdAt,
    derivationKey,
    defaultPostageStampBatchID: account.defaultPostageStampBatchID,
    settings: account.settings,
    accountNameAt: account.accountNameAt,
    defaultStampAt: account.defaultStampAt,
    settingsAt: account.settingsAt,
    lastModified: opts.lastModified ?? Date.now(),
    devices: [...account.devices],
    connectedApps: [...account.connectedApps],
    postageStamps: [...account.postageStamps],
    partitionCount: account.partitionCount,
  }
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
 * Coalesced callers share ONE `FoldAccountResult` instance — treat it as
 * read-only; a caller that mutates the result corrupts the others. The result's
 * arrays are frozen before return so such a mutation fails loud rather than
 * silently (see `doFoldAccountFromSwarm`).
 */
const inFlightFolds = new Map<string, Promise<FoldAccountResult | undefined>>()

/**
 * Derive the feed owner + encryption key from the account derivation key, read
 * the roster, fold all device-state feeds. Returns `undefined` when the roster
 * is empty (no device has published — equivalent to today's "no-backup").
 *
 * Concurrent calls for the same account share one in-flight read (see
 * `inFlightFolds`); `bee` is intentionally keyed OUT — every client reads the
 * same feeds. Coalescing across two DIFFERENT `bee` endpoints (e.g. a local
 * cluster and a public gateway mid-transition) is safe, not a bug: a fold is a
 * point-in-time, eventually-consistent LWW/CRDT snapshot (roster + device-state
 * both fold last-writer-wins by their per-field `at` clocks — see
 * `merge-snapshot.ts` / `device-state.ts`). No caller assumes a fold reflects a
 * specific endpoint's live view, so a coalesced caller receiving the other
 * endpoint's equally-valid snapshot is indistinguishable from ordinary gateway
 * staleness — which the LWW fold already tolerates everywhere, and the next
 * (uncoalesced, entry-cleared) fold re-reads and re-converges. Do NOT add `bee`
 * to the key to "fix" this; it would only defeat the coalescing.
 */
export async function foldAccountFromSwarm(opts: {
  bee: Bee
  derivationKey: string
  accountId: string
}): Promise<FoldAccountResult | undefined> {
  const key = `${opts.accountId}:${opts.derivationKey}`
  const existing = inFlightFolds.get(key)
  if (existing) return existing
  const fold = doFoldAccountFromSwarm(opts).finally(() => {
    inFlightFolds.delete(key)
  })
  inFlightFolds.set(key, fold)
  return fold
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

  const account = foldAccount(views, devices)
  // Coalesced callers share this ONE result (see `inFlightFolds`). Freeze the
  // arrays they iterate so a stray mutation throws loudly instead of silently
  // corrupting a concurrent caller's view.
  // ponytail: shallow freeze (arrays only, not each element) — catches the
  // realistic push/splice/sort corruption since today's callers only read or
  // pass these into the pure `merge*` helpers, which never mutate their inputs.
  // If a caller ever mutates an element in place, deep-freeze the elements too
  // (or clone the result per caller).
  for (const arr of [
    devices,
    account.devices,
    account.connectedApps,
    account.postageStamps,
  ]) {
    if (Array.isArray(arr)) Object.freeze(arr)
  }
  return { account, devices }
}
