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
 * Derive the feed owner + encryption key from the account derivation key, read
 * the roster, fold all device-state feeds. Returns `undefined` when the roster
 * is empty (no device has published — equivalent to today's "no-backup").
 */
export async function foldAccountFromSwarm(opts: {
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

  // Fold the latest view of every non-removed device. A device whose feed is
  // unreachable is skipped (best-effort), not fatal — its peers' views still
  // converge the shared entities.
  const views: DeviceStateSnapshot[] = []
  for (const device of devices) {
    if (device.removedAt) continue
    const view = await readLatestDeviceState({
      bee: opts.bee,
      accountId: opts.accountId,
      deviceId: device.deviceId,
      owner,
    }).catch(() => undefined)
    if (view) views.push(view)
  }

  return { account: foldAccount(views, devices), devices }
}
