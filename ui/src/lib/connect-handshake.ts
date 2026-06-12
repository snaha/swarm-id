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
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import {
  DEFAULT_SESSION_DURATION,
  PARTITION_COUNT,
  type ConnectedApp as SharedConnectedApp,
  createAccountsStorageManager,
  createConnectedAppsStorageManager,
  createIdentitiesStorageManager,
  createPostageStampsStorageManager,
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

/** The stamp the proxy should upload with: the account default or its first stamp. */
function defaultBatchId(account: Account): BatchId | undefined {
  const batchId = account.defaultStampBatchId ?? account.stamps[0]?.batchId
  return batchId === undefined ? undefined : new BatchId(batchId)
}

/** Mirror the account's stamps into the shared postage-stamps store the proxy reads. */
function saveSharedStamps(account: Account): void {
  if (account.stamps.length === 0) {
    return
  }
  const manager = createPostageStampsStorageManager()
  const mine = new Set(account.stamps.map((stamp) => bareHex(stamp.batchId)))
  const others = manager.load().filter((stamp) => !mine.has(bareHex(stamp.batchID.toHex())))
  manager.save([
    ...others,
    ...account.stamps.map((stamp) => ({
      batchID: new BatchId(stamp.batchId),
      signerKey: new PrivateKey(stamp.signerKey),
      utilization: stamp.utilization,
      usable: stamp.usable,
      depth: stamp.depth,
      amount: BigInt(stamp.amount),
      bucketDepth: stamp.bucketDepth,
      blockNumber: stamp.blockNumber,
      immutableFlag: stamp.immutableFlag,
      exists: stamp.exists,
      batchTTL: stamp.batchTTL,
      createdAt: stamp.createdAt,
    })),
  ])
}

/**
 * Upsert the shared `accounts`, `identities`, and `postageStamps` records the
 * proxy resolves a connection (and its upload stamp) against. The new UI has
 * no separate identity concept, so the account doubles as its single identity
 * (identity id = account address).
 */
async function saveSharedRecords(account: Account, masterKey: string): Promise<void> {
  const accountId = new EthAddress(account.id)
  const identityId = bareHex(account.id)
  const stampBatchId = defaultBatchId(account)

  const accountsManager = createAccountsStorageManager()
  const sharedAccounts = accountsManager.load()
  if (sharedAccounts.some((shared) => shared.id.equals(accountId))) {
    accountsManager.save(
      sharedAccounts.map((shared) =>
        shared.id.equals(accountId)
          ? {
              ...shared,
              name: account.name,
              defaultPostageStampBatchID: stampBatchId ?? shared.defaultPostageStampBatchID,
            }
          : shared,
      ),
    )
  } else {
    accountsManager.save([
      ...sharedAccounts,
      {
        type: 'agent',
        id: accountId,
        name: account.name,
        createdAt: account.createdAt,
        derivationKey: await deriveAccountDerivationKey(masterKey),
        defaultPostageStampBatchID: stampBatchId,
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
        identity.id === identityId
          ? {
              ...identity,
              name: account.name,
              publicKey,
              defaultPostageStampBatchID: stampBatchId ?? identity.defaultPostageStampBatchID,
            }
          : identity,
      ),
    )
  } else {
    identitiesManager.save([
      ...identities,
      {
        id: identityId,
        accountId,
        name: account.name,
        publicKey,
        defaultPostageStampBatchID: stampBatchId,
        createdAt: account.createdAt,
      },
    ])
  }

  saveSharedStamps(account)
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

function updateSharedConnections(
  identityId: string,
  matches: (app: SharedConnectedApp) => boolean,
  change: (app: SharedConnectedApp) => SharedConnectedApp,
): void {
  const manager = createConnectedAppsStorageManager()
  manager.save(
    manager
      .load()
      .map((app) => (app.identityId === identityId && matches(app) ? change(app) : app)),
  )
}

function revoked(app: SharedConnectedApp, tombstone: boolean): SharedConnectedApp {
  const now = Date.now()
  return {
    ...app,
    appSecret: undefined,
    connectedUntil: undefined,
    lastConnectedAt: 0,
    updatedAt: now,
    revokedAt: tombstone ? now : app.revokedAt,
  }
}

/**
 * Invalidate the app's shared connected-app record: drops the app secret so
 * the dApp's proxy iframe de-authenticates (storage event) and a reconnect
 * needs a fresh unlock ceremony.
 */
export function disconnectSharedConnection(account: Account, appUrl: string): void {
  updateSharedConnections(
    bareHex(account.id),
    (app) => app.appUrl === appUrl,
    (app) => revoked(app, false),
  )
}

/** Disconnect and tombstone the shared record so the removal propagates to sync. */
export function removeSharedConnection(account: Account, appUrl: string): void {
  updateSharedConnections(
    bareHex(account.id),
    (app) => app.appUrl === appUrl,
    (app) => revoked(app, true),
  )
}

/**
 * Erase the account's shared-storage footprint: revoke every connected app
 * (de-authenticating their proxy iframes), then drop the identity, account,
 * and postage-stamp records.
 */
export function removeSharedAccountRecords(account: Account): void {
  const accountId = new EthAddress(account.id)
  const identityId = bareHex(account.id)

  updateSharedConnections(
    identityId,
    () => true,
    (app) => revoked(app, true),
  )

  const identitiesManager = createIdentitiesStorageManager()
  identitiesManager.save(identitiesManager.load().filter((identity) => identity.id !== identityId))

  const accountsManager = createAccountsStorageManager()
  accountsManager.save(accountsManager.load().filter((shared) => !shared.id.equals(accountId)))

  if (account.stamps.length > 0) {
    const mine = new Set(account.stamps.map((stamp) => bareHex(stamp.batchId)))
    const stampsManager = createPostageStampsStorageManager()
    stampsManager.save(
      stampsManager.load().filter((stamp) => !mine.has(bareHex(stamp.batchID.toHex()))),
    )
  }
}
