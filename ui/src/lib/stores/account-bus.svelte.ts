// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The SwarmID tab's account bus (docs/Account-Bus.md, `account-delta`).
 *
 * This tab is where a revoke happens, and until now nothing told the dApp
 * proxies about it: a partitioned iframe cannot see shared storage, so a
 * revoked Safari session kept its hydrated account view — every stamp's signer
 * key — until the page closed. The proxy learned to consume `account-delta`;
 * this is the publisher.
 *
 * **Signaling transport only.** The contexts a `BroadcastChannel` would reach —
 * other SwarmID tabs, an unpartitioned iframe on this origin — already converge
 * through `storage` events. The one context that cannot is the partitioned
 * iframe, which is in another storage partition, and only a server round trip
 * crosses that.
 */
import {
  AccountBus,
  SignalingTransport,
  accountDeltaSnapshot,
  accountStateSnapshot,
  deriveBusContext,
} from '@snaha/swarm-id'
import type { SyncedAccount } from '@snaha/swarm-id'

import { busSignalingUrl } from '$lib/bus-signaling-url'

/**
 * Coalesce a burst of mutations into one publish. Far shorter than the 2 s
 * Swarm-sync debounce: that one batches feed writes, this one carries a revoke,
 * and a revoke the user is watching for should not wait on a batching window.
 */
const PUBLISH_DEBOUNCE_MS = 300

let bus: AccountBus | undefined
let joinedKey: string | undefined
let publishTimer: ReturnType<typeof setTimeout> | undefined
let pending: SyncedAccount | undefined
/** Bumped by every join and leave, so a join whose key derivation is still in
 *  flight can tell it has been superseded — an account switch mid-derivation
 *  must not put this tab in the previous account's room. */
let generation = 0

function closeBus(): void {
  bus?.close()
  bus = undefined
  joinedKey = undefined
}

async function attach(account: SyncedAccount, forGeneration: number): Promise<void> {
  const url = busSignalingUrl()
  // No bus server for this build: nothing to join, and nothing a publish could
  // reach. The proxy side reaches the same conclusion independently.
  if (!url) return

  const context = await deriveBusContext(account.derivationKey)
  if (forGeneration !== generation) return

  const transport = new SignalingTransport({
    url,
    topic: context.topic,
    encryptionKey: context.encryptionKey,
    createPeerConnection:
      typeof RTCPeerConnection !== 'undefined' ? () => new RTCPeerConnection() : undefined,
  })
  bus = new AccountBus([transport])
  joinedKey = account.derivationKey
}

function publishNow(account: SyncedAccount): void {
  if (!bus || account.derivationKey !== joinedKey) return
  const snapshot = accountStateSnapshot(account)
  if (!snapshot) return
  bus.publish({ type: 'account-delta', snapshot: accountDeltaSnapshot(snapshot) })
}

export const accountBusStore = {
  /**
   * Join the account's room. Idempotent per account; switching accounts leaves
   * the previous room first, so this tab never sits in two.
   */
  join(account: SyncedAccount): void {
    if (joinedKey === account.derivationKey) return
    closeBus()
    const forGeneration = ++generation
    void attach(account, forGeneration).catch((error: unknown) => {
      console.error('[AccountBus] Failed to join the account room:', error)
    })
  },

  /** Leave the room (sign-out, account cleared, page teardown). */
  leave(): void {
    generation += 1
    if (publishTimer !== undefined) {
      clearTimeout(publishTimer)
      publishTimer = undefined
    }
    pending = undefined
    closeBus()
  },

  /**
   * Announce this account's state to its other live contexts. Debounced, and
   * a no-op for an account this tab has not joined — one room per account, so
   * publishing account B into account A's room is the cross-account leak the
   * derived topic exists to prevent.
   */
  publish(account: SyncedAccount): void {
    pending = account
    if (publishTimer !== undefined) clearTimeout(publishTimer)
    publishTimer = setTimeout(() => {
      publishTimer = undefined
      const account = pending
      pending = undefined
      if (account) publishNow(account)
    }, PUBLISH_DEBOUNCE_MS)
  },
}
