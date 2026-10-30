// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The deleting device's teardown. What it pins is the ordering: the record is
 * removed only once the deletion has been published, because the record is
 * what publishes it, and apps are revoked only once the deletion is certain.
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import type { SignedInAccount, SyncedAccount } from '@snaha/swarm-id/internal'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountsStore } from '$lib/stores/accounts.svelte'
import { sessionStore } from '$lib/stores/session.svelte'

import { deleteAccount, tearDownAccount } from './delete-account'
import { derivePostageSigner } from './payment/purchase'

vi.mock('$app/environment', () => ({ browser: false }))

const sync = vi.hoisted(() => ({ syncAccount: vi.fn() }))
vi.mock('$lib/dev/sync.svelte', () => ({ syncStore: sync }))

const bus = vi.hoisted(() => ({ publishBeforeClose: vi.fn() }))
vi.mock('$lib/stores/account-bus', () => ({ accountBusStore: bus }))

const dilution = vi.hoisted(() => ({ runDeleteDilution: vi.fn() }))
vi.mock('$lib/payment/drive-operation', () => dilution)

vi.hoisted(() => {
  const backing = new Map<string, string>()
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  }
  Object.assign(globalThis, {
    window: {
      localStorage: localStorageStub,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
    localStorage: localStorageStub,
  })
})

const ID_HEX = 'a'.repeat(40)
const BATCH_HEX = 'c'.repeat(64)
const APP_URL = 'https://dapp.example.com'
const PUBLISHED = {
  status: 'success',
  reference: 'ab'.repeat(32),
  timestamp: 1n,
  chunkAddresses: [],
}

function record(withDrive: boolean): SignedInAccount {
  return {
    id: new EthAddress(ID_HEX),
    name: 'Doomed',
    createdAt: 1,
    derivationKey: 'f'.repeat(64),
    publicKey: '02' + 'ab'.repeat(32),
    access: { type: 'password', kdfSalt: 'a'.repeat(32), kdfIterations: 1 },
    encryptedSeed: 'ab'.repeat(44),
    devices: [],
    connectedApps: [
      { appUrl: APP_URL, appName: 'dApp', lastConnectedAt: 1, appSecret: '44'.repeat(32) },
    ],
    postageStamps: withDrive
      ? [
          {
            batchID: new BatchId(BATCH_HEX),
            signerKey: new PrivateKey('b'.repeat(64)),
            depth: 20,
            amount: 1n,
            bucketDepth: 16,
            blockNumber: 1,
            immutableFlag: false,
            utilization: 0,
            usable: true,
            exists: true,
            createdAt: 1,
          },
        ]
      : [],
    defaultPostageStampBatchID: withDrive ? new BatchId(BATCH_HEX) : undefined,
  }
}

beforeEach(() => {
  accountsStore.clear()
  vi.clearAllMocks()
  bus.publishBeforeClose.mockResolvedValue(undefined)
})

afterEach(() => {
  sessionStore.clearCurrentAccount()
})

describe('tearDownAccount', () => {
  it('publishes the deletion, revokes, then removes the account', async () => {
    const account = accountsStore.add(record(true))
    sessionStore.setCurrentAccount(account.id)
    // What the account says at the moment it is published.
    let atPublish: { deleted: boolean; revokedAt: number | undefined } | undefined
    sync.syncAccount.mockImplementation(() => {
      const held = accountsStore.get(ID_HEX)
      atPublish = { deleted: held?.deleted ?? false, revokedAt: held?.connectedApps[0].revokedAt }
      return Promise.resolve(PUBLISHED)
    })

    await tearDownAccount(account)

    expect(sync.syncAccount).toHaveBeenCalledWith(ID_HEX)
    expect(atPublish).toEqual({ deleted: true, revokedAt: undefined })
    const announced = bus.publishBeforeClose.mock.calls[0][0] as SyncedAccount
    expect(announced.deleted).toBe(true)
    expect(announced.connectedApps[0].revokedAt).toEqual(expect.any(Number))
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
    expect(sessionStore.currentAccountId).toBeUndefined()
  })

  // Live peers forget the account the moment the bus delta lands, so it may
  // only go out once the feed write has: otherwise a failed publish leaves
  // them without an account this device still has.
  it('tells live peers only after the deletion is on Swarm', async () => {
    const account = accountsStore.add(record(true))
    let busBeforeSwarm = false
    sync.syncAccount.mockImplementation(async () => {
      // As the feed write settles, not as it starts: a bus publish sent
      // alongside it has been called by then.
      await Promise.resolve()
      busBeforeSwarm = bus.publishBeforeClose.mock.calls.length > 0
      return PUBLISHED
    })

    await tearDownAccount(account)

    expect(busBeforeSwarm).toBe(false)
    expect(bus.publishBeforeClose).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no publish could be made', undefined],
    ['the publish failed', { status: 'error', error: 'Bee unreachable' }],
  ])('keeps the account, unmarked, when %s', async (_label, outcome) => {
    const account = accountsStore.add(record(true))
    sync.syncAccount.mockResolvedValue(outcome)

    await expect(tearDownAccount(account)).rejects.toThrow()

    // Kept and live again: a marker left behind would go out with the next
    // routine sync and delete the account everywhere else, unannounced. The
    // reversal is clocked after the marker, so it also outvotes one that
    // reached Swarm before the failure.
    const kept = accountsStore.get(ID_HEX)
    expect(kept?.deleted).toBe(false)
    expect(kept?.deletedAt).toEqual(expect.any(Number))
    // Nothing was deleted, so nothing was disconnected either.
    expect(kept?.connectedApps[0].revokedAt).toBeUndefined()
    expect(bus.publishBeforeClose).not.toHaveBeenCalled()
  })

  it('keeps the account, unmarked, when the publish threw', async () => {
    const account = accountsStore.add(record(true))
    sync.syncAccount.mockRejectedValue(new Error('lock lost'))

    await expect(tearDownAccount(account)).rejects.toThrow('lock lost')

    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
    expect(bus.publishBeforeClose).not.toHaveBeenCalled()
  })

  it('keeps the account when its marker was taken back mid-publish', async () => {
    const account = accountsStore.add(record(true))
    sync.syncAccount.mockImplementation(() => {
      account.cancelDeletion()
      return Promise.resolve(PUBLISHED)
    })

    await expect(tearDownAccount(account)).rejects.toThrow('interrupted')

    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
    expect(bus.publishBeforeClose).not.toHaveBeenCalled()
  })

  it('marks the account afresh on a retry, and finishes', async () => {
    const account = accountsStore.add(record(true))
    sync.syncAccount.mockResolvedValueOnce(undefined)
    await expect(tearDownAccount(account)).rejects.toThrow()

    let deletedAtPublish: boolean | undefined
    sync.syncAccount.mockImplementationOnce(() => {
      deletedAtPublish = accountsStore.get(ID_HEX)?.deleted
      return Promise.resolve(PUBLISHED)
    })
    await tearDownAccount(account)

    expect(deletedAtPublish).toBe(true)
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
  })

  // No device can read the account from Swarm without a live default drive,
  // so there is nothing to publish there; live peers still hear of it.
  it.each([
    ['has no default drive', { defaultPostageStampBatchID: undefined }],
    ['has an expired default drive', { batchTTL: 0, createdAt: 1 }],
  ])('tells only the bus when the account %s', async (_label, patch) => {
    const base = record(true)
    const account = accountsStore.add({
      ...base,
      defaultPostageStampBatchID:
        'defaultPostageStampBatchID' in patch ? undefined : base.defaultPostageStampBatchID,
      postageStamps: base.postageStamps.map((stamp) => ({ ...stamp, ...patch })),
    })

    await tearDownAccount(account)

    expect(sync.syncAccount).not.toHaveBeenCalled()
    const announced = bus.publishBeforeClose.mock.calls[0][0] as SyncedAccount
    expect(announced.deleted).toBe(true)
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
  })

  // Nothing of a local account lives on Swarm, and it has no drive to publish
  // through.
  it('removes a local account without publishing', async () => {
    const account = accountsStore.add(record(false))

    await tearDownAccount(account)

    expect(sync.syncAccount).not.toHaveBeenCalled()
    expect(bus.publishBeforeClose).not.toHaveBeenCalled()
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
  })
})

describe('deleteAccount', () => {
  const requestFunding = vi.fn()
  const checkpoint = vi.fn()

  beforeEach(() => {
    sync.syncAccount.mockResolvedValue(PUBLISHED)
    dilution.runDeleteDilution.mockResolvedValue({ status: 'complete', drives: [] })
  })

  it('dilutes with the derived signer, then deletes', async () => {
    const account = accountsStore.add(record(true))
    const keep = new Set([BATCH_HEX])
    const { signerKey } = await derivePostageSigner(account.derivationKey)

    const result = await deleteAccount({ account, keep, requestFunding, checkpoint })

    expect(result).toEqual({ status: 'deleted' })
    const [options] = dilution.runDeleteDilution.mock.calls[0]
    expect(options.signerKey.toHex()).toBe(signerKey.toHex())
    expect(options.keep).toBe(keep)
    expect(options.beforeSpend).toBe(checkpoint)
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
  })

  // Declining the gas is a question for the user, not a decision: nothing is
  // torn down until they choose to delete without diluting.
  it('tears nothing down when the gas was declined', async () => {
    const account = accountsStore.add(record(true))
    dilution.runDeleteDilution.mockResolvedValue({ status: 'unfunded', drives: [] })

    const result = await deleteAccount({ account, keep: new Set(), requestFunding, checkpoint })

    expect(result).toEqual({ status: 'unfunded' })
    expect(sync.syncAccount).not.toHaveBeenCalled()
    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
  })

  it('deletes undiluted when asked, handing over the signer key', async () => {
    const account = accountsStore.add(record(true))
    const { signerKey } = await derivePostageSigner(account.derivationKey)

    const result = await deleteAccount({
      account,
      keep: new Set(),
      requestFunding,
      undiluted: true,
      checkpoint,
    })

    expect(result).toEqual({ status: 'partial', signerPrivateKey: `0x${signerKey.toHex()}` })
    expect(dilution.runDeleteDilution).not.toHaveBeenCalled()
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
  })

  it('keeps the account, unmarked, when a dilution transaction failed', async () => {
    const account = accountsStore.add(record(true))
    dilution.runDeleteDilution.mockResolvedValue({ status: 'failed', drives: [] })

    await expect(
      deleteAccount({ account, keep: new Set(), requestFunding, checkpoint }),
    ).rejects.toThrow()

    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
    expect(sync.syncAccount).not.toHaveBeenCalled()
  })

  it('tears nothing down once the caller has moved on', async () => {
    const account = accountsStore.add(record(true))
    const superseded = new Error('superseded')

    await expect(
      deleteAccount({
        account,
        keep: new Set(),
        requestFunding,
        checkpoint: () => {
          throw superseded
        },
      }),
    ).rejects.toBe(superseded)

    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
  })

  it('skips the chain for a local account', async () => {
    const account = accountsStore.add(record(false))

    const result = await deleteAccount({ account, keep: new Set(), requestFunding, checkpoint })

    expect(result).toEqual({ status: 'deleted' })
    expect(dilution.runDeleteDilution).not.toHaveBeenCalled()
    expect(accountsStore.get(ID_HEX)).toBeUndefined()
  })
})
