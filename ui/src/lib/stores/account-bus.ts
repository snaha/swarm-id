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
 *
 * Both halves live here now: this tab publishes its own changes, and folds a
 * peer's into shared storage (`$lib/stores/account-delta`), which is how a
 * change made on ANOTHER DEVICE reaches this device's unpartitioned contexts
 * at all — they read storage, and no storage event crosses a device boundary.
 */
import {
  AccountBus,
  SignalingTransport,
  accountDeltaSnapshot,
  accountToStateSnapshot,
  deriveBusContext,
} from '@snaha/swarm-id'
import type { SyncedAccount } from '@snaha/swarm-id'

import { busSignalingUrl } from '$lib/bus-signaling-url'
import { applyAccountDelta } from '$lib/stores/account-delta'

/**
 * Coalesce a burst of mutations into one publish. Far shorter than the 2 s
 * Swarm-sync debounce: that one batches feed writes, this one carries a revoke,
 * and a revoke the user is watching for should not wait on a batching window.
 */
export const PUBLISH_DEBOUNCE_MS = 300

let bus: AccountBus | undefined
/** Detaches the delta consumer; the bus outlives no join, but a stale handler
 *  folding another account's room would. */
let unsubscribe: (() => void) | undefined
/** The account this tab is committed to, set the moment `join()` is called
 *  rather than when the transport comes up: a publish landing during the
 *  derivation belongs to this account and must be held, not dropped. */
let joinedKey: string | undefined
/** The in-flight join, so a publish can wait for it instead of racing it. */
let attaching: Promise<void> | undefined
let publishTimer: ReturnType<typeof setTimeout> | undefined
let pending: SyncedAccount | undefined
/** Bumped by every join and leave, so a join whose key derivation is still in
 *  flight can tell it has been superseded — an account switch mid-derivation
 *  must not put this tab in the previous account's room. */
let generation = 0

function closeBus(): void {
  unsubscribe?.()
  unsubscribe = undefined
  bus?.close()
  bus = undefined
  joinedKey = undefined
  attaching = undefined
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
  // The receive half (#608). A peer's delta is folded into shared storage
  // here, which is the only way a change made on another device reaches this
  // device's UNpartitioned contexts — they read storage, and no storage event
  // crosses a device boundary. `applyAccountDelta` commits with `skipSync`, so
  // this never publishes back.
  unsubscribe = bus.subscribe((message) => {
    if (message.type === 'account-delta') applyAccountDelta(message.snapshot)
  })
}

function publishNow(account: SyncedAccount): void {
  // A superseded or failed join leaves no bus, and `leave()` clears the key.
  if (!bus || account.derivationKey !== joinedKey) return
  // No default-stamp gate: that is the FEED write's precondition (it is paid
  // for by the stamp), not a bus message's. An account with no drives still has
  // apps to revoke and partitioned sessions that hear about it only here.
  const snapshot = accountToStateSnapshot(account, account.id.toHex(), Date.now())
  bus.publish({ type: 'account-delta', snapshot: accountDeltaSnapshot(snapshot) })
}

/** Wait out a join still deriving its topic, then publish. Without the wait a
 *  revoke committed right after an account is selected is dropped, and nothing
 *  re-sends it — the next mutation is the earliest a peer hears anything. */
async function flush(account: SyncedAccount): Promise<void> {
  await attaching
  publishNow(account)
}

export const accountBusStore = {
  /**
   * Join the account's room. Idempotent per account; switching accounts leaves
   * the previous room first, so this tab never sits in two.
   */
  join(account: SyncedAccount): void {
    if (joinedKey === account.derivationKey) return
    closeBus()
    joinedKey = account.derivationKey
    const forGeneration = ++generation
    attaching = attach(account, forGeneration).catch((error: unknown) => {
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
    // Refused HERE, not at publish time: the debounce holds one account, so an
    // unjoined one accepted now evicts the joined one's pending delta and is
    // then dropped on its way out — losing a revoke rather than ignoring a
    // stranger.
    if (account.derivationKey !== joinedKey) return
    pending = account
    if (publishTimer !== undefined) clearTimeout(publishTimer)
    publishTimer = setTimeout(() => {
      publishTimer = undefined
      const account = pending
      pending = undefined
      if (account) void flush(account)
    }, PUBLISH_DEBOUNCE_MS)
  },
}
