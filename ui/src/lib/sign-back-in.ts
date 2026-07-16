// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sign a signed-out account back in from its retained vault. The sign-out
 * stripped every synced field from disk, so the unlocked entropy re-derives
 * the master key and `derivationKey`, the synced state is folded back from
 * Swarm (the same read the phrase-import flow does), and the full record
 * replaces the minimal remnant via `accountsStore.add` — which reuses the
 * live instance, clearing `signedOutAt` in place for every held reference.
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
import { accountsStore } from '$lib/stores/accounts.svelte'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import type { Account } from '$lib/types'

/**
 * Restore `account` to signed-in from its unlocked entropy. Throws (for the
 * unlock dialog to surface) when the Swarm network is unreachable — signing
 * back in from a stale local copy is not an option, since sign-out kept none.
 */
export async function signBackIn(account: Account, entropy: Uint8Array): Promise<Account> {
  const vault = account.vault
  const wallet = walletFromEntropy(entropy)
  if (!account.id.equals(new EthAddress(wallet.address))) {
    // The vault decrypted to some other account's seed — a corrupted record,
    // not a wrong credential (that fails inside `unlockAccount` already).
    throw new Error('The unlocked seed does not match this account.')
  }
  const derivationKey = await deriveAccountDerivationKey(strip0x(wallet.privateKey))
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
  if (!folded && !(await connectedPromise)) {
    throw new Error("Couldn't reach the Swarm network. Check your connection and try again.")
  }

  const restored: SyncedAccount = folded
    ? foldedToSyncedAccount({ id: account.id, derivationKey, account: folded.account })
    : {
        // Reachable but nothing published under this account (it never
        // synced) — restore a fresh shell, same as the import flow's
        // set-up-fresh path.
        id: account.id,
        name: account.name,
        createdAt: account.createdAt,
        derivationKey,
        publicKey: strip0x(wallet.publicKey),
        devices: [],
        connectedApps: [],
        postageStamps: [],
        partitionCount: PARTITION_COUNT,
      }
  if (folded) {
    // Stamp the fold cooldown so the forced fold right after sign-in skips
    // within the grace window instead of re-folding back-to-back.
    noteAccountFolded(accountId)
  }

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
