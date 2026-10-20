// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Completing a dApp connection from the connect popup.
 *
 * The account is the single nested record (the `@snaha/swarm-id` Zod model
 * persisted under `STORAGE_KEY_ACCOUNTS`): it owns the `connectedApps` entry
 * carrying the app secret the dApp's proxy iframe authenticates from. Writing it
 * (via `accountsStore`) fires a storage event in the iframe, which picks up the
 * session. When storage is partitioned the secret is handed to the iframe via a
 * `setSecret` postMessage instead.
 *
 * Key model (master key = the account wallet's private key): the per-app secret
 * derives straight from the master key (`deriveSecret(master, appOrigin)`).
 */
import {
  type ConnectedApp,
  type SyncedAccount,
  appSessionDuration,
  deriveSecret,
  serializeSyncedAccount,
  stampsReachableByApp,
} from '@snaha/swarm-id/internal'

import { strip0x } from '$lib/crypto/hex'
import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'
import type { ConnectRequest } from '$lib/stores/connect.svelte'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
import type { Account } from '$lib/types'

/**
 * The drives the user granted on the connect screen (#862). Absent, the
 * entry's grant is left as it was: nothing for a first connect, the earlier
 * choice for a reconnect.
 */
export interface DriveGrant {
  drives: ConnectedApp['drives']
}

/**
 * Write the connected-app entry into the account record (this is what fires the
 * storage event the proxy iframe authenticates from). The grant goes in with
 * it, on its own clock, so the handover below already sees it.
 */
function saveConnection(
  account: Account,
  request: ConnectRequest,
  appSecret: string,
  grant: DriveGrant | undefined,
): void {
  const now = Date.now()
  const connection: ConnectedApp = {
    appUrl: request.appOrigin,
    appName: request.appName,
    appIcon: request.appIcon,
    appDescription: request.appDescription,
    appSecret,
    lastConnectedAt: now,
    connectedUntil: now + appSessionDuration(account.settings),
    ...(grant ? { drives: grant.drives, drivesAt: now } : {}),
  }
  account.connectApp(connection)
}

/**
 * The account view handed to a partitioned proxy iframe: the synced projection
 * (no vault, no app secrets) with the stamp collection narrowed to the ones
 * THIS app's drive grant names (#578, #862).
 *
 * The iframe is on the SwarmID origin and an unpartitioned proxy reads the same
 * material out of shared storage, so this is least privilege rather than a
 * boundary being fixed. But before #547 a partitioned session held no
 * credentials at all, and it now holds real ones in a context embedded by an
 * arbitrary dApp page: anything that gains script execution there gets what it
 * was handed. It can only ever spend the drives it was granted, so the rest
 * of the collection's signer keys are pure exposure with no use.
 *
 * `derivationKey` stays, and that is the honest trade-off to state rather than
 * hide: the account bus derives its topic and envelope key from it
 * (`deriveBusContext`), and the partition lease derives the Swarm encryption
 * key and the lock-SOC signer from it (`deriveSwarmEncryptionKey` →
 * `backup-key`). A partitioned session cannot write without it.
 *
 * Which means this narrows what the session HOLDS, not what it could learn: the
 * key that opens the room stays, and an `account-delta` carries the whole
 * collection (the publisher is unpartitioned and does not know its receivers'
 * apps), so script execution in that iframe can wait for one message. Bounding
 * that as well needs per-app deltas in a per-app room — out of scope for #578.
 */
export function partitionHandoverAccount(
  account: SyncedAccount,
  appOrigin: string,
): Record<string, unknown> {
  const app = account.connectedApps.find((entry) => entry.appUrl === appOrigin)
  return serializeSyncedAccount({
    ...account,
    postageStamps: stampsReachableByApp({ drives: app?.drives }, account, account.postageStamps),
  })
}

/**
 * Storage-partitioning fallback: hand the secret straight to the proxy iframe
 * (our window.opener) since it can't see our localStorage. `account` carries
 * the narrowed synced projection above — the identity the dApp is shown comes
 * off it, so nothing separate is sent for that (docs/Account-Bus.md, phase 3).
 *
 * The projection is not optional: `AuthDataSchema` requires it, and a payload
 * without one is refused rather than producing a session that cannot upload
 * and cannot be told it was revoked.
 */
function sendSecretToOpener(account: Account, request: ConnectRequest, appSecret: string): void {
  if (!request.partitionChallenge || !window.opener) {
    return
  }
  const message = {
    type: 'setSecret',
    appOrigin: request.appOrigin,
    challenge: request.partitionChallenge,
    data: {
      secret: appSecret,
      account: partitionHandoverAccount(account.toSyncedRecord(), request.appOrigin),
      networkSettings: networkSettingsStore.settings,
    },
  }
  // The account collections and network settings are Svelte $state proxies,
  // which structured clone rejects (DataCloneError). The payload is already
  // the JSON wire shape, so a JSON round-trip strips the reactivity.
  window.opener.postMessage(JSON.parse(JSON.stringify(message)), window.location.origin)
}

/**
 * The app secret for this account and app, derived at unlock. Only this
 * crosses to the done page: the seed entropy itself stays with the ceremony
 * that produced it.
 */
export async function deriveAppSecret(entropy: Uint8Array, appOrigin: string): Promise<string> {
  const masterKey = strip0x(privateKeyFromEntropy(entropy))
  return deriveSecret(masterKey, appOrigin)
}

/**
 * The secret of a still-valid prior connection to this app, so no unlock is
 * needed; undefined when a full unlock + derivation is required.
 */
export function reusableAppSecret(account: Account, appOrigin: string): string | undefined {
  return account.connectedApps.find(
    (app) =>
      app.appUrl === appOrigin &&
      app.appSecret !== undefined &&
      app.revokedAt === undefined &&
      (app.connectedUntil ?? 0) > Date.now(),
  )?.appSecret
}

/**
 * Persist the connection with the secret in hand, fresh or reused, and hand
 * it to a partitioned iframe. The proxy iframe in the dApp picks it up via
 * storage event (or postMessage when partitioned) and authenticates.
 */
export function commitConnect(
  account: Account,
  request: ConnectRequest,
  appSecret: string,
  grant?: DriveGrant,
): void {
  saveConnection(account, request, appSecret, grant)
  sendSecretToOpener(account, request, appSecret)
}
