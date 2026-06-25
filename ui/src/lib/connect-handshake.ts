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
import { type ConnectedApp, DEFAULT_SESSION_DURATION, deriveSecret } from '@snaha/swarm-id'

import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'
import { accountsStore } from '$lib/stores/accounts.svelte'
import type { ConnectRequest } from '$lib/stores/connect.svelte'
import type { Account } from '$lib/types'
import { bareHex } from '$lib/utils'

function connectionDuration(account: Account): number {
  return account.settings?.appSessionDuration ?? DEFAULT_SESSION_DURATION
}

/**
 * Write the connected-app entry into the account record (this is what fires the
 * storage event the proxy iframe authenticates from).
 */
function saveConnection(account: Account, request: ConnectRequest, appSecret: string): void {
  const now = Date.now()
  const connection: ConnectedApp = {
    appUrl: request.appOrigin,
    appName: request.appName,
    appIcon: request.appIcon,
    appDescription: request.appDescription,
    appSecret,
    lastConnectedAt: now,
    connectedUntil: now + connectionDuration(account),
    updatedAt: now,
  }
  accountsStore.connectApp(account.id, connection)
}

/**
 * Storage-partitioning fallback: hand the secret straight to the proxy iframe
 * (our window.opener) since it can't see our localStorage. The `identity*`
 * fields carry the account's info (single-level model).
 */
function sendSecretToOpener(account: Account, request: ConnectRequest, appSecret: string): void {
  if (!request.partitionChallenge || !window.opener) {
    return
  }
  const idHex = account.id.toHex()
  window.opener.postMessage(
    {
      type: 'setSecret',
      appOrigin: request.appOrigin,
      challenge: request.partitionChallenge,
      data: {
        secret: appSecret,
        identityId: idHex,
        identityName: account.name,
        identityAddress: idHex,
        identityPublicKey: account.publicKey ?? '',
      },
    },
    window.location.origin,
  )
}

/**
 * Derive the app secret from the unlocked account and persist the connection.
 * The proxy iframe in the dApp picks it up via storage event (or postMessage
 * when partitioned) and authenticates.
 */
export async function completeConnect(
  account: Account,
  entropy: Uint8Array,
  request: ConnectRequest,
): Promise<void> {
  const masterKey = bareHex(privateKeyFromEntropy(entropy))
  const appSecret = await deriveSecret(masterKey, request.appOrigin)
  saveConnection(account, request, appSecret)
  sendSecretToOpener(account, request, appSecret)
}

/**
 * Reconnect with the secret of a still-valid prior connection, skipping the
 * unlock ceremony. Returns false when there is none and a full
 * unlock + derivation is required.
 */
export function reuseConnection(account: Account, request: ConnectRequest): boolean {
  const existing = account.connectedApps.find(
    (app) =>
      app.appUrl === request.appOrigin &&
      app.appSecret !== undefined &&
      app.revokedAt === undefined &&
      (app.connectedUntil ?? 0) > Date.now(),
  )
  if (!existing?.appSecret) {
    return false
  }
  saveConnection(account, request, existing.appSecret)
  sendSecretToOpener(account, request, existing.appSecret)
  return true
}

/**
 * Invalidate the app's connected-app record: drops the app secret so the dApp's
 * proxy iframe de-authenticates (storage event) and a reconnect needs a fresh
 * unlock ceremony.
 */
export function disconnectSharedConnection(account: Account, appUrl: string): void {
  accountsStore.disconnectApp(account.id, appUrl)
}

/** Disconnect and tombstone the record so the removal propagates to sync. */
export function removeSharedConnection(account: Account, appUrl: string): void {
  accountsStore.removeApp(account.id, appUrl)
}

/**
 * Erase the account's storage footprint: removing the record drops its
 * connected apps and drives with it, and the storage event de-authenticates any
 * dApp proxy iframes.
 */
export function removeSharedAccountRecords(account: Account): void {
  accountsStore.remove(account.id)
}
