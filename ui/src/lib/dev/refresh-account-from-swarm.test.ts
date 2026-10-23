// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Swarm fold's half of the account deletion marker: a device that was
 * closed while another one deleted the account learns of it here, on its next
 * refresh, since it heard no bus delta.
 */
import { EthAddress } from '@ethersphere/bee-js'
import { type SignedInAccount, foldAccountFromSwarm } from '@snaha/swarm-id/internal'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DELETED_ELSEWHERE_MESSAGE } from '$lib/account-deleted'
import { accountsStore } from '$lib/stores/accounts.svelte'
import { sessionStore } from '$lib/stores/session.svelte'
import { toastStore } from '$lib/stores/toast.svelte'

import { refreshAccountFromSwarm } from './refresh-account-from-swarm'

vi.mock('$app/environment', () => ({ browser: false }))

// The fold is network I/O — stub it; everything else in the lib stays real.
vi.mock('@snaha/swarm-id/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@snaha/swarm-id/internal')>()),
  foldAccountFromSwarm: vi.fn(),
}))

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
const CREATED_AT = 1_000_000
const DELETED_AT = CREATED_AT + 5_000

/** What a fold that found something resolves with. */
type Folded = NonNullable<Awaited<ReturnType<typeof foldAccountFromSwarm>>>

function record(overrides?: Partial<SignedInAccount>): SignedInAccount {
  return {
    id: new EthAddress(ID_HEX),
    name: 'Local Name',
    createdAt: CREATED_AT,
    derivationKey: 'f'.repeat(64),
    publicKey: '02' + 'ab'.repeat(32),
    access: { type: 'password', kdfSalt: 'a'.repeat(32), kdfIterations: 1 },
    encryptedSeed: 'ab'.repeat(44),
    devices: [],
    connectedApps: [],
    postageStamps: [],
    ...overrides,
  }
}

function folded(deleted: boolean, deletedAt: number): Folded {
  return {
    account: {
      devices: [],
      connectedApps: [],
      postageStamps: [],
      accountName: 'Local Name',
      defaultPostageStampBatchID: undefined,
      settings: undefined,
      accountNameAt: CREATED_AT,
      defaultStampAt: CREATED_AT,
      settingsAt: CREATED_AT,
      deleted,
      deletedAt,
      createdAt: CREATED_AT,
      publicKey: '02' + 'ab'.repeat(32),
      partitionCount: 2,
    },
    devices: [],
  }
}

beforeEach(() => {
  accountsStore.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  sessionStore.clearCurrentAccount()
})

describe('refreshAccountFromSwarm — account deletion', () => {
  it('forgets an account another device deleted', async () => {
    const account = accountsStore.add(record())
    sessionStore.setCurrentAccount(account.id)
    const show = vi.spyOn(toastStore, 'show')
    vi.mocked(foldAccountFromSwarm).mockResolvedValue(folded(true, DELETED_AT))

    await refreshAccountFromSwarm(ID_HEX)

    expect(accountsStore.get(ID_HEX)).toBeUndefined()
    expect(sessionStore.currentAccountId).toBeUndefined()
    expect(show).toHaveBeenCalledWith(DELETED_ELSEWHERE_MESSAGE)
  })

  it('keeps an account restored since', async () => {
    accountsStore.add(record({ deleted: false, deletedAt: DELETED_AT + 1 }))
    vi.mocked(foldAccountFromSwarm).mockResolvedValue(folded(true, DELETED_AT))

    await refreshAccountFromSwarm(ID_HEX)

    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
  })

  it('takes a restore made on another device', async () => {
    accountsStore.add(record({ deleted: true, deletedAt: DELETED_AT }))
    vi.mocked(foldAccountFromSwarm).mockResolvedValue(folded(false, DELETED_AT + 1))

    await refreshAccountFromSwarm(ID_HEX)

    expect(accountsStore.get(ID_HEX)?.deleted).toBe(false)
  })
})
