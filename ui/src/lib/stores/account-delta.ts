// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The receive half of `account-delta` in the SwarmID tab (#608,
 * docs/Account-Bus.md).
 *
 * The publisher landed first, and until now nothing here consumed: a change
 * made on another device reached an *unpartitioned* session only through a
 * storage event or the popup handshake, so a revoke on device A never reached
 * device B's proxy iframe at all. This folds a peer's delta into **shared
 * storage**, which is what every unpartitioned context on this device already
 * reads — the partitioned ones keep their own in-memory fold in the proxy.
 *
 * It is the same shape as the Swarm fold beside it
 * (`$lib/dev/refresh-account-from-swarm`): merge the remote collections with
 * the local ones using the shared LWW primitives, then apply through
 * `applyRefreshed`, which folds the scalars on their per-field clocks.
 *
 * **`applyRefreshed` is also the echo guard.** It commits with
 * `skipSync: true`, so consuming a delta fires neither the Swarm publish nor
 * the bus publish — the proxy states the same rule as `source === "bus"`. A
 * fold that republished what it just received is a loop between two devices
 * that never settles.
 */
import { BatchId } from '@ethersphere/bee-js'
import {
  mergeConnectedApps,
  mergeDevicesList,
  mergePostageStamps,
  restoreLocalSessionFields,
} from '@snaha/swarm-id'
import type { AccountStateSnapshot } from '@snaha/swarm-id'

import { accountsStore } from '$lib/stores/accounts.svelte'

/**
 * Fold one peer's snapshot into the stored account.
 *
 * A snapshot for an account this device does not hold, or holds only as a
 * sign-out remnant, is dropped: the remnant kept no `derivationKey`, and
 * writing synced state back onto it would resurrect an account the user signed
 * out of.
 */
export function applyAccountDelta(snapshot: AccountStateSnapshot): void {
  const account = accountsStore.get(snapshot.accountId)
  if (!account || account.isSignedOut) return

  // Local side first, as everywhere else: a tie on a collection entry keeps
  // ours rather than adopting a peer's identical-clock copy.
  const mergedApps = mergeConnectedApps(account.connectedApps, snapshot.connectedApps)

  account.applyRefreshed({
    devices: mergeDevicesList(account.devices, snapshot.metadata.devices),
    // The wire strips `appSecret` and `connectedUntil` from every entry — the
    // receive schema does it again — so a merely newer incoming entry (a
    // rename, a reconnect elsewhere) would otherwise log this device out of an
    // app nobody revoked. Ours go back unless the entry says the session
    // ENDED, which is exactly what a revoke has to be able to say.
    connectedApps: restoreLocalSessionFields(mergedApps, account.connectedApps),
    postageStamps: mergePostageStamps(account.postageStamps, snapshot.postageStamps),
    accountName: snapshot.metadata.accountName,
    accountNameAt: snapshot.metadata.accountNameAt,
    // Hex on the wire, a `BatchId` in the account record.
    defaultPostageStampBatchID: snapshot.metadata.defaultPostageStampBatchID
      ? new BatchId(snapshot.metadata.defaultPostageStampBatchID)
      : undefined,
    defaultStampAt: snapshot.metadata.defaultStampAt,
    settings: snapshot.metadata.settings,
    settingsAt: snapshot.metadata.settingsAt,
  })
}
