// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The receive half of `account-delta` in the SwarmID tab (#608).
 *
 * What these pin is the pair of rules a consumer gets wrong in opposite
 * directions: a merge that keeps the wire's stripped session fields logs this
 * device out of apps nobody revoked, and one that always keeps ours ignores the
 * revoke it was sent. Plus the echo guard — folding a peer's delta must not
 * publish anything, or two devices trade the same change forever.
 */
import { BatchId, EthAddress } from '@ethersphere/bee-js'
import {
  type Account as AccountRecord,
  type AccountStateSnapshot,
  type ConnectedApp,
  createAccountsStorageManager,
} from '@snaha/swarm-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyAccountDelta } from './account-delta'
import { accountsStore, setAccountsSyncHook } from './accounts.svelte'

// Same harness as `accounts.svelte.test.ts`: the store reads `browser` and
// `window.localStorage` at import time, and `browser: false` keeps the
// boot-time load and the cross-tab listener out of the way.
vi.mock('$app/environment', () => ({ browser: false }))

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
const OTHER_ID_HEX = 'b'.repeat(40)
const APP_URL = 'https://dapp.example.com'
const OTHER_APP_URL = 'https://other.example.com'
const APP_SECRET = '44'.repeat(32)
const BATCH_ID_HEX = 'cc'.repeat(32)
const PEER_BATCH_ID_HEX = 'dd'.repeat(32)
const CREATED_AT = 1_000_000

function localApp(overrides?: Partial<ConnectedApp>): ConnectedApp {
  return {
    appUrl: APP_URL,
    appName: 'dApp',
    lastConnectedAt: CREATED_AT,
    appSecret: APP_SECRET,
    connectedUntil: CREATED_AT + 1_000,
    ...overrides,
  }
}

function record(overrides?: Partial<AccountRecord>): AccountRecord {
  return {
    id: new EthAddress(ID_HEX),
    name: 'Local Name',
    createdAt: CREATED_AT,
    derivationKey: 'f'.repeat(64),
    publicKey: '02' + 'ab'.repeat(32),
    access: { type: 'password', kdfSalt: 'a'.repeat(32), kdfIterations: 1 },
    encryptedSeed: 'ab'.repeat(44),
    devices: [],
    connectedApps: [localApp()],
    postageStamps: [],
    ...overrides,
  } as AccountRecord
}

/**
 * A peer's snapshot as it arrives: the schema strips `appSecret` and
 * `connectedUntil` off every entry on receive, so the fixtures must not carry
 * them either — a test that leaves them in tests a message that cannot exist.
 */
function delta(overrides?: {
  accountId?: string
  connectedApps?: ConnectedApp[]
  accountName?: string
  accountNameAt?: number
  defaultPostageStampBatchID?: string
  defaultStampAt?: number
}): AccountStateSnapshot {
  return {
    version: 1,
    timestamp: CREATED_AT + 5_000,
    accountId: overrides?.accountId ?? ID_HEX,
    metadata: {
      accountName: overrides?.accountName ?? 'Local Name',
      defaultPostageStampBatchID: overrides?.defaultPostageStampBatchID,
      publicKey: '02' + 'ab'.repeat(32),
      settings: undefined,
      accountNameAt: overrides?.accountNameAt ?? CREATED_AT,
      defaultStampAt: overrides?.defaultStampAt ?? CREATED_AT,
      settingsAt: CREATED_AT,
      createdAt: CREATED_AT,
      lastModified: CREATED_AT + 5_000,
      devices: [],
      partitionCount: 1,
    },
    connectedApps: overrides?.connectedApps ?? [
      { appUrl: APP_URL, appName: 'dApp', lastConnectedAt: CREATED_AT },
    ],
    postageStamps: [],
  } as AccountStateSnapshot
}

/** Read what is actually persisted, through an independent manager instance. */
function storedApp(appUrl = APP_URL): ConnectedApp | undefined {
  const account = createAccountsStorageManager()
    .load()
    .find((entry) => entry.id.equals(new EthAddress(ID_HEX)))
  return account && 'connectedApps' in account
    ? account.connectedApps.find((app) => app.appUrl === appUrl)
    : undefined
}

beforeEach(() => {
  accountsStore.clear()
  setAccountsSyncHook(undefined)
})

describe('applyAccountDelta', () => {
  it('folds a peer’s revoke into stored truth', () => {
    accountsStore.add(record())
    const revokedAt = CREATED_AT + 5_000

    applyAccountDelta(
      delta({
        connectedApps: [
          {
            appUrl: APP_URL,
            appName: 'dApp',
            lastConnectedAt: CREATED_AT,
            updatedAt: revokedAt,
            disconnectedAt: revokedAt,
            revokedAt,
          },
        ],
      }),
    )

    expect(storedApp()?.revokedAt).toBe(revokedAt)
    // The credential goes with it, or an unpartitioned proxy reading this
    // record stays authenticated for an app that was removed.
    expect(storedApp()?.appSecret).toBeUndefined()
  })

  // The wire carries no session fields at all, so a merely NEWER entry — a
  // rename, a reconnect on another device — would otherwise blank the secret
  // this device is actively using.
  it('keeps this device’s session for an app the delta did not end', () => {
    accountsStore.add(record())

    applyAccountDelta(
      delta({
        connectedApps: [
          {
            appUrl: APP_URL,
            appName: 'dApp renamed elsewhere',
            lastConnectedAt: CREATED_AT,
            updatedAt: CREATED_AT + 5_000,
          },
        ],
      }),
    )

    expect(storedApp()?.appName).toBe('dApp renamed elsewhere')
    expect(storedApp()?.appSecret).toBe(APP_SECRET)
    expect(storedApp()?.connectedUntil).toBe(CREATED_AT + 1_000)
  })

  // A plain Disconnect is not a tombstone, so the entry survives — but the
  // session it names does not.
  it('ends the session on a disconnect newer than ours', () => {
    accountsStore.add(record())

    applyAccountDelta(
      delta({
        connectedApps: [
          {
            appUrl: APP_URL,
            appName: 'dApp',
            lastConnectedAt: CREATED_AT,
            updatedAt: CREATED_AT + 5_000,
            disconnectedAt: CREATED_AT + 5_000,
          },
        ],
      }),
    )

    expect(storedApp()?.revokedAt).toBeUndefined()
    expect(storedApp()?.appSecret).toBeUndefined()
  })

  it('learns about an app connected on another device', () => {
    accountsStore.add(record())

    applyAccountDelta(
      delta({
        connectedApps: [
          { appUrl: APP_URL, appName: 'dApp', lastConnectedAt: CREATED_AT },
          { appUrl: OTHER_APP_URL, appName: 'other', lastConnectedAt: CREATED_AT + 5_000 },
        ],
      }),
    )

    expect(storedApp(OTHER_APP_URL)?.appName).toBe('other')
    // ...without losing our own session for the app we already had.
    expect(storedApp()?.appSecret).toBe(APP_SECRET)
  })

  it('folds the scalars on their own clocks, in both directions', () => {
    accountsStore.add(record())

    applyAccountDelta(delta({ accountName: 'Renamed', accountNameAt: CREATED_AT + 5_000 }))
    expect(accountsStore.get(ID_HEX)?.name).toBe('Renamed')

    applyAccountDelta(delta({ accountName: 'Older', accountNameAt: CREATED_AT + 1 }))
    expect(accountsStore.get(ID_HEX)?.name).toBe('Renamed')
  })

  it('follows a default stamp moved on another device', () => {
    accountsStore.add(record({ defaultPostageStampBatchID: new BatchId(BATCH_ID_HEX) }))

    applyAccountDelta(
      delta({
        defaultPostageStampBatchID: PEER_BATCH_ID_HEX,
        defaultStampAt: CREATED_AT + 5_000,
      }),
    )

    expect(accountsStore.get(ID_HEX)?.defaultPostageStampBatchID?.toHex()).toBe(PEER_BATCH_ID_HEX)
  })

  // The echo guard. `applyRefreshed` commits with `skipSync`, so nothing
  // reaches the propagation seam — the proxy states the same rule as
  // `source === "bus"`. Without it two devices trade one change forever.
  it('publishes nothing back', () => {
    accountsStore.add(record())
    const syncHook = vi.fn()
    setAccountsSyncHook(syncHook)

    applyAccountDelta(delta({ accountName: 'Renamed', accountNameAt: CREATED_AT + 5_000 }))
    expect(syncHook).not.toHaveBeenCalled()

    // A control, or the assertion above would also pass with the seam unwired.
    accountsStore.get(ID_HEX)?.rename('Renamed here')
    expect(syncHook).toHaveBeenCalledTimes(1)
  })

  it('ignores a delta for an account this device does not hold', () => {
    accountsStore.add(record())

    applyAccountDelta(
      delta({
        accountId: OTHER_ID_HEX,
        accountName: 'Elsewhere',
        accountNameAt: CREATED_AT + 5_000,
      }),
    )

    expect(accountsStore.get(ID_HEX)?.name).toBe('Local Name')
  })

  // The remnant kept no `derivationKey`; writing synced state back onto it
  // would resurrect an account the user signed out of.
  it('ignores a delta for a signed-out account', () => {
    const account = accountsStore.add(record())
    account.signOut('encrypted-state')

    applyAccountDelta(delta({ accountName: 'Renamed', accountNameAt: CREATED_AT + 5_000 }))

    expect(accountsStore.get(ID_HEX)?.name).not.toBe('Renamed')
  })
})
