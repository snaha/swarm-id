// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Completing a dApp connection from the connect popup.
 *
 * The proxy iframe embedded in the dApp authenticates from the shared
 * localStorage account document (written through the @snaha/swarm-id storage
 * manager): a nested account record that owns the `connectedApps` entry carrying
 * the app secret. Writing it fires a storage event in the iframe, which picks up
 * the session. When storage is partitioned the secret is handed to the iframe
 * via a `setSecret` postMessage instead.
 *
 * Key model (master key = the account wallet's private key): the account is the
 * single app-facing identity, so the per-app secret derives straight from the
 * master key (`deriveSecret(master, appOrigin)`).
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import {
  DEFAULT_SESSION_DURATION,
  PARTITION_COUNT,
  type Account as SharedAccount,
  type ConnectedApp as SharedConnectedApp,
  type PostageStamp as SharedPostageStamp,
  createAccountsStorageManager,
  deriveAccountDerivationKey,
  deriveSecret,
} from '@snaha/swarm-id'

import { privateKeyFromEntropy } from '$lib/crypto/mnemonic'
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

/** The drive the proxy should upload with: the account default or its first drive. */
function defaultBatchId(account: Account): BatchId | undefined {
  const batchId = account.defaultDriveBatchId ?? account.drives[0]?.batchId
  return batchId === undefined ? undefined : new BatchId(batchId)
}

/** The account's drives in the shared (@snaha/swarm-id) PostageStamp shape. */
function sharedStamps(account: Account): SharedPostageStamp[] {
  return account.drives.map((drive) => ({
    batchID: new BatchId(drive.batchId),
    signerKey: new PrivateKey(drive.signerKey),
    utilization: drive.utilization,
    usable: drive.usable,
    depth: drive.depth,
    amount: BigInt(drive.amount),
    bucketDepth: drive.bucketDepth,
    blockNumber: drive.blockNumber,
    immutableFlag: drive.immutableFlag,
    exists: drive.exists,
    batchTTL: drive.batchTTL,
    createdAt: drive.createdAt,
  }))
}

/** Upsert the matching shared account record via `mutate`, persisting the result. */
function updateSharedAccount(
  accountId: EthAddress,
  mutate: (account: SharedAccount) => SharedAccount,
): void {
  const manager = createAccountsStorageManager()
  manager.save(
    manager.load().map((account) => (account.id.equals(accountId) ? mutate(account) : account)),
  )
}

/**
 * Upsert the shared nested account record the proxy resolves a connection (and
 * its upload drive) against. The account is its own single identity, owning its
 * connected apps and drives inline.
 */
async function saveSharedRecords(account: Account, masterKey: string): Promise<void> {
  const accountId = new EthAddress(account.id)
  const driveBatchId = defaultBatchId(account)
  const publicKey = bareHex(account.publicKey)

  const manager = createAccountsStorageManager()
  const accounts = manager.load()
  const existing = accounts.find((shared) => shared.id.equals(accountId))

  if (existing) {
    manager.save(
      accounts.map((shared) =>
        shared.id.equals(accountId)
          ? {
              ...shared,
              name: account.name,
              publicKey,
              defaultPostageStampBatchID: driveBatchId ?? shared.defaultPostageStampBatchID,
              postageStamps: sharedStamps(account),
            }
          : shared,
      ),
    )
  } else {
    manager.save([
      ...accounts,
      {
        type: 'agent',
        id: accountId,
        name: account.name,
        createdAt: account.createdAt,
        derivationKey: await deriveAccountDerivationKey(masterKey),
        publicKey,
        defaultPostageStampBatchID: driveBatchId,
        devices: [],
        connectedApps: [],
        postageStamps: sharedStamps(account),
        partitionCount: PARTITION_COUNT,
      },
    ])
  }
}

/**
 * Write the connected-app entry into the shared account record (this is what
 * fires the storage event the proxy iframe authenticates from) and mirror the
 * connection into the UI's own account record.
 */
function saveConnection(account: Account, request: ConnectRequest, appSecret: string): void {
  const accountId = new EthAddress(account.id)
  const now = Date.now()
  const connection: SharedConnectedApp = {
    appUrl: request.appOrigin,
    appName: request.appName,
    appIcon: request.appIcon,
    appDescription: request.appDescription,
    appSecret,
    lastConnectedAt: now,
    connectedUntil: now + connectionDuration(account),
    updatedAt: now,
  }

  updateSharedAccount(accountId, (shared) => {
    const has = shared.connectedApps.some((app) => app.appUrl === connection.appUrl)
    const connectedApps = has
      ? shared.connectedApps.map((app) =>
          app.appUrl === connection.appUrl ? { ...app, ...connection, revokedAt: undefined } : app,
        )
      : [...shared.connectedApps, connection]
    return { ...shared, connectedApps }
  })

  account.connectApp({
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
 * iframe (our window.opener) since it can't see our localStorage. The
 * `identity*` fields carry the account's info (single-level model).
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
  const accountId = new EthAddress(account.id)
  const shared = createAccountsStorageManager()
    .load()
    .find((a) => a.id.equals(accountId))
  const existing = shared?.connectedApps.find(
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
  updateSharedAccount(new EthAddress(account.id), (shared) => ({
    ...shared,
    connectedApps: shared.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, false) : app,
    ),
  }))
}

/** Disconnect and tombstone the shared record so the removal propagates to sync. */
export function removeSharedConnection(account: Account, appUrl: string): void {
  updateSharedAccount(new EthAddress(account.id), (shared) => ({
    ...shared,
    connectedApps: shared.connectedApps.map((app) =>
      app.appUrl === appUrl ? revoked(app, true) : app,
    ),
  }))
}

/**
 * Erase the account's shared-storage footprint: removing the nested account
 * record drops its connected apps and drives with it, and the storage event
 * de-authenticates any dApp proxy iframes.
 */
export function removeSharedAccountRecords(account: Account): void {
  const accountId = new EthAddress(account.id)
  const manager = createAccountsStorageManager()
  manager.save(manager.load().filter((shared) => !shared.id.equals(accountId)))
}

/**
 * Erase every shared-storage account record (developer reset). De-authenticates
 * all dApp proxy iframes on this origin via the resulting storage event.
 */
export function removeAllSharedAccountRecords(): void {
  createAccountsStorageManager().clear()
}
