// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sign a signed-out account back in from its retained vault. The sign-out
 * stripped every synced field from plaintext disk but kept them as an
 * encrypted snapshot (`encryptedState`), so the unlocked entropy re-derives
 * the master key and `derivationKey`, decrypts the snapshot, and restores the
 * full record via `accountsStore.add` — which reuses the live instance,
 * clearing `signedOutAt` in place for every held reference. No network
 * needed; the background fold reconciles with peers afterwards.
 *
 * Only when the snapshot is missing or corrupt (tampered storage) does the
 * restore fall back to folding the state from Swarm — and an empty fold there
 * surfaces as `NoSyncedDataError` instead of silently restoring an empty
 * account, unless the caller explicitly opted into `allowEmpty`.
 */
import { Bee, EthAddress } from '@ethersphere/bee-js'
import {
  PARTITION_COUNT,
  type SyncedAccount,
  deriveAccountDerivationKey,
  foldAccountFromSwarm,
  foldedToSyncedAccount,
} from '@snaha/swarm-id'

import { strip0x } from '$lib/crypto/hex'
import { walletFromEntropy } from '$lib/crypto/mnemonic'
import { noteAccountFolded } from '$lib/dev/account-refresh'
import { triggerSync } from '$lib/dev/sync-hooks'
import { decryptSignOutSnapshot } from '$lib/sign-out-snapshot'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import type { Account } from '$lib/types'

/**
 * The account is reachable on the network but has no synced data there, and
 * no local snapshot could restore it. Restoring would produce an EMPTY
 * account — callers surface an explicit warning and retry with `allowEmpty`
 * only on user confirmation.
 */
export class NoSyncedDataError extends Error {
  constructor() {
    super('No synced data was found for this account on the Swarm network.')
    this.name = 'NoSyncedDataError'
  }
}

/**
 * Restore `account` to signed-in from its unlocked entropy. Throws (for the
 * unlock dialog to surface) when the snapshot is unusable AND the network
 * fold cannot restore the state — `NoSyncedDataError` when the network
 * answered "nothing there" (see above), a plain retry-able error when it was
 * unreachable.
 */
export async function signBackIn(
  account: Account,
  entropy: Uint8Array,
  opts?: { allowEmpty?: boolean },
): Promise<Account> {
  const vault = account.vault
  const wallet = walletFromEntropy(entropy)
  if (!account.id.equals(new EthAddress(wallet.address))) {
    // The vault decrypted to some other account's seed — a corrupted record,
    // not a wrong credential (that fails inside `unlockAccount` already).
    throw new Error('The unlocked seed does not match this account.')
  }
  const derivationKey = await deriveAccountDerivationKey(strip0x(wallet.privateKey))
  const accountId = account.id.toHex()

  const restored =
    (await restoreFromSnapshot(account, derivationKey)) ??
    (await restoreFromSwarm(account, derivationKey, {
      publicKey: strip0x(wallet.publicKey),
      allowEmpty: opts?.allowEmpty === true,
    }))

  const live = accountsStore.add({
    ...restored,
    access: vault.access,
    encryptedSeed: vault.encryptedSeed,
  })
  // `add` persists but doesn't fire the sync hook, so publish once to
  // re-register this device in the Swarm roster (mirrors the import flow's
  // finalize). No-ops harmlessly until the account has a stamp to sign with.
  triggerSync(accountId)
  return live
}

/**
 * The normal path: decrypt the snapshot the sign-out kept. Undefined when it
 * is missing or unusable. Deliberately does NOT stamp the fold cooldown — the
 * snapshot is local, so the next fold tick still reconciles with peers.
 */
async function restoreFromSnapshot(
  account: Account,
  derivationKey: string,
): Promise<SyncedAccount | undefined> {
  const encryptedState = account.encryptedState
  if (encryptedState === undefined) {
    return undefined
  }
  try {
    const restored = await decryptSignOutSnapshot(encryptedState, derivationKey)
    // A snapshot for a different id would restore someone else's state onto
    // this row — treat it as corrupt and fall back to the network.
    return restored.id.equals(account.id) ? restored : undefined
  } catch {
    return undefined
  }
}

/**
 * Fallback: fold the state from Swarm (the same read as first sign-in on a
 * new device). Empty fold on a reachable network throws `NoSyncedDataError`
 * unless `allowEmpty` — restoring a fresh shell silently would read as data
 * loss.
 */
async function restoreFromSwarm(
  account: Account,
  derivationKey: string,
  opts: { publicKey: string; allowEmpty: boolean },
): Promise<SyncedAccount> {
  const bee = new Bee(networkSettingsStore.beeNodeUrl)
  const accountId = account.id.toHex()

  // The fold's roster reader swallows read failures into an empty roster, so
  // it can't by itself tell "never synced" from "network down". The
  // reachability probe disambiguates, but its answer only matters when the
  // fold finds nothing — so run it alongside the fold instead of serially in
  // front. `.catch(false)` both prevents a floating rejection and treats a
  // probe error as "unreachable".
  const connectedPromise = bee.isConnected().catch(() => false)
  const folded = await foldAccountFromSwarm({ bee, derivationKey, accountId })
  if (folded) {
    // Stamp the fold cooldown so the forced fold right after sign-in skips
    // within the grace window instead of re-folding back-to-back.
    noteAccountFolded(accountId)
    return foldedToSyncedAccount({ id: account.id, derivationKey, account: folded.account })
  }
  if (!(await connectedPromise)) {
    throw new Error("Couldn't reach the Swarm network. Check your connection and try again.")
  }
  if (!opts.allowEmpty) {
    throw new NoSyncedDataError()
  }
  // Explicitly accepted: restore a fresh shell with nothing but the identity.
  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt,
    derivationKey,
    publicKey: opts.publicKey,
    devices: [],
    connectedApps: [],
    postageStamps: [],
    partitionCount: PARTITION_COUNT,
  }
}
