// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The store hears writes made in its OWN window by another storage manager
 * instance — the proxy iframe's, when the identity UI runs inside it (#712).
 */
import { EthAddress } from '@ethersphere/bee-js'
import {
  type AccountStateSnapshot,
  type ConnectedApp,
  type SignedInAccount,
  createAccountsStorageManager,
} from '@snaha/swarm-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyAccountDelta } from './account-delta'
import { accountsStore, setAccountsSyncHook } from './accounts.svelte'

// `browser: true`, unlike the sibling suites: the listener under test is the
// one the store installs at boot.
vi.mock('$app/environment', () => ({ browser: true }))

vi.hoisted(() => {
  const backing = new Map<string, string>()
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  }
  // A window that delivers `dispatchEvent` to every listener of the event's
  // type, so one manager's same-window write reaches the others' handlers.
  const listeners = new Map<string, Set<(event: Event) => void>>()
  Object.assign(globalThis, {
    window: {
      localStorage: localStorageStub,
      addEventListener: (type: string, listener: (event: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.get(type)?.delete(listener)
      },
      dispatchEvent: (event: Event) => {
        for (const listener of listeners.get(event.type) ?? []) listener(event)
        return true
      },
    },
    localStorage: localStorageStub,
  })
})

const ID_HEX = 'a'.repeat(40)
const APP_URL = 'https://dapp.example.com'
const APP_SECRET = '44'.repeat(32)
const CREATED_AT = 1_000_000
const DISCONNECTED_AT = CREATED_AT + 1_000

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
    connectedApps: [
      {
        appUrl: APP_URL,
        appName: 'dApp',
        lastConnectedAt: CREATED_AT,
        appSecret: APP_SECRET,
        connectedUntil: CREATED_AT + 1_000,
      },
    ],
    postageStamps: [],
    ...overrides,
  }
}

/** What the proxy's `clearAuthData` writes, through a manager of its own. */
function proxyDisconnects(): void {
  createAccountsStorageManager().save([
    record({
      connectedApps: [
        {
          appUrl: APP_URL,
          appName: 'dApp',
          lastConnectedAt: CREATED_AT,
          disconnectedAt: DISCONNECTED_AT,
        },
      ],
    }),
  ])
}

/** A peer's copy of the entry, from before it folded the Disconnect. */
function peerDelta(): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: CREATED_AT + 5_000,
    accountId: ID_HEX,
    metadata: {
      accountName: 'Local Name',
      defaultPostageStampBatchID: undefined,
      publicKey: '02' + 'ab'.repeat(32),
      settings: undefined,
      accountNameAt: CREATED_AT,
      defaultStampAt: CREATED_AT,
      settingsAt: CREATED_AT,
      createdAt: CREATED_AT,
      lastModified: CREATED_AT + 5_000,
      devices: [],
      partitionCount: 1,
    },
    connectedApps: [{ appUrl: APP_URL, appName: 'dApp', lastConnectedAt: CREATED_AT }],
    postageStamps: [],
  }
}

function storedApp(): ConnectedApp | undefined {
  const account = createAccountsStorageManager()
    .load()
    .find((entry) => entry.id.equals(new EthAddress(ID_HEX)))
  return account && 'connectedApps' in account
    ? account.connectedApps.find((app) => app.appUrl === APP_URL)
    : undefined
}

beforeEach(() => {
  accountsStore.clear()
  setAccountsSyncHook(undefined)
})

describe('a same-window write by another manager instance', () => {
  it('updates the live Account', () => {
    const account = accountsStore.add(record())
    proxyDisconnects()
    expect(account.connectedApps[0].disconnectedAt).toBe(DISCONNECTED_AT)
    expect(account.connectedApps[0].appSecret).toBeUndefined()
  })

  it('is not undone by the next peer delta (#712)', () => {
    accountsStore.add(record())
    proxyDisconnects()
    applyAccountDelta(peerDelta())
    expect(storedApp()?.disconnectedAt).toBe(DISCONNECTED_AT)
    expect(storedApp()?.appSecret).toBeUndefined()
  })
})
