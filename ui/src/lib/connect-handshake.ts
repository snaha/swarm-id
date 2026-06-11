// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Completing a dApp connection from the connect popup.
 *
 * The proxy iframe embedded in the dApp authenticates from records in shared
 * localStorage (written through the @snaha/swarm-id storage managers): a
 * `connectedApps` entry carrying the app secret, plus the `identities` and
 * `accounts` records it resolves the connection against. Writing the
 * connected-app entry fires a storage event in the iframe, which picks up the
 * session — same handshake as the legacy UI. When storage is partitioned the
 * secret is handed to the iframe via a `setSecret` postMessage instead.
 *
 * Key hierarchy (master key = the account wallet's private key, matching
 * legacy agent accounts): master key → identity key → per-app secret.
 */
import { EthAddress } from '@ethersphere/bee-js'
import {
  DEFAULT_SESSION_DURATION,
  PARTITION_COUNT,
  type ConnectedApp as SharedConnectedApp,
  createAccountsStorageManager,
  createConnectedAppsStorageManager,
  createIdentitiesStorageManager,
  deriveAccountDerivationKey,
  deriveIdentityKey,
  deriveSecret,
} from '@snaha/swarm-id'

import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'
import { accountsStore } from '$lib/stores/accounts.svelte'
import type { ConnectRequest } from '$lib/stores/connect.svelte'
import type { Account } from '$lib/types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Shared-storage records use bare lowercase hex (no 0x prefix). */
function bareHex(value: string): string {
  return (value.startsWith('0x') ? value.slice(2) : value).toLowerCase()
}

function connectionDuration(account: Account): number {
  return account.appConnectionDays !== undefined
    ? account.appConnectionDays * MS_PER_DAY
    : DEFAULT_SESSION_DURATION
}

/**
 * Ensure the shared `accounts` and `identities` records the proxy resolves a
 * connection against exist. The new UI has no separate identity concept, so
 * the account doubles as its single identity (identity id = account address).
 */
async function saveSharedRecords(account: Account, masterKey: string): Promise<void> {
  const accountId = new EthAddress(account.id)
  const identityId = bareHex(account.id)

  const accountsManager = createAccountsStorageManager()
  const sharedAccounts = accountsManager.load()
  if (!sharedAccounts.some((shared) => shared.id.equals(accountId))) {
    accountsManager.save([
      ...sharedAccounts,
      {
        type: 'agent',
        id: accountId,
        name: account.name,
        createdAt: account.createdAt,
        derivationKey: await deriveAccountDerivationKey(masterKey),
        devices: [],
        partitionCount: PARTITION_COUNT,
      },
    ])
  }

  const identitiesManager = createIdentitiesStorageManager()
  const identities = identitiesManager.load()
  const publicKey = bareHex(account.publicKey)
  const existing = identities.find((identity) => identity.id === identityId)
  if (existing) {
    identitiesManager.save(
      identities.map((identity) =>
        identity.id === identityId ? { ...identity, name: account.name, publicKey } : identity,
      ),
    )
  } else {
    identitiesManager.save([
      ...identities,
      { id: identityId, accountId, name: account.name, publicKey, createdAt: account.createdAt },
    ])
  }
}

/**
 * Write the connected-app entry to shared storage (this is what fires the
 * storage event the proxy iframe authenticates from) and mirror the
 * connection into the UI's own account record.
 */
function saveConnection(account: Account, request: ConnectRequest, appSecret: string): void {
  const identityId = bareHex(account.id)
  const now = Date.now()
  const connection: SharedConnectedApp = {
    appUrl: request.appOrigin,
    appName: request.appName,
    appIcon: request.appIcon,
    appDescription: request.appDescription,
    identityId,
    appSecret,
    lastConnectedAt: now,
    connectedUntil: now + connectionDuration(account),
    updatedAt: now,
  }

  const manager = createConnectedAppsStorageManager()
  const apps = manager.load()
  const existing = apps.some(
    (app) => app.appUrl === connection.appUrl && app.identityId === identityId,
  )
  manager.save(
    existing
      ? apps.map((app) =>
          app.appUrl === connection.appUrl && app.identityId === identityId
            ? { ...app, ...connection, revokedAt: undefined }
            : app,
        )
      : [...apps, connection],
  )

  accountsStore.connectApp(account.id, {
    appUrl: request.appOrigin,
    appName: request.appName,
    appIcon: request.appIcon,
    appDescription: request.appDescription,
    lastConnectedAt: now,
    connectedUntil: connection.connectedUntil,
  })
}

/**
 * Storage-partitioning fallback: hand the secret straight to the proxy
 * iframe (our window.opener) since it can't see our localStorage.
 */
function sendSecretToOpener(account: Account, request: ConnectRequest, appSecret: string): void {
  if (!request.partitionChallenge || !window.opener) {
    return
  }
  window.opener.postMessage(
    {
      type: 'setSecret',
      appOrigin: request.appOrigin,
      challenge: request.partitionChallenge,
      data: {
        secret: appSecret,
        identityId: bareHex(account.id),
        identityName: account.name,
        identityAddress: bareHex(account.id),
        identityPublicKey: bareHex(account.publicKey),
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
  await saveSharedRecords(account, masterKey)
  const identityKey = await deriveIdentityKey(masterKey, bareHex(account.id))
  const appSecret = await deriveSecret(identityKey, request.appOrigin)
  saveConnection(account, request, appSecret)
  sendSecretToOpener(account, request, appSecret)
}

/**
 * Reconnect with the secret of a still-valid prior connection, skipping the
 * unlock ceremony. Returns false when there is none and a full
 * unlock + derivation is required.
 */
export function reuseConnection(account: Account, request: ConnectRequest): boolean {
  const identityId = bareHex(account.id)
  const existing = createConnectedAppsStorageManager()
    .load()
    .find(
      (app) =>
        app.appUrl === request.appOrigin &&
        app.identityId === identityId &&
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
