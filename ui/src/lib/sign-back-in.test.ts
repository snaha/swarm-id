// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The sign-out → sign-back-in restore chain, fully offline: the encrypted
 * snapshot kept by `signOut()` must restore the synced state losslessly from
 * the unlocked entropy alone (no network), and the network fallback must
 * refuse to silently restore an empty account (`NoSyncedDataError`) unless
 * the caller explicitly allows it.
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import { deriveAccountDerivationKey, foldAccountFromSwarm } from '@snaha/swarm-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { strip0x } from './crypto/hex'
import { walletFromPhrase } from './crypto/mnemonic'
import { NoSyncedDataError, signBackIn } from './sign-back-in'
import { decryptSignOutSnapshot, encryptSignOutSnapshot } from './sign-out-snapshot'
import { accountsStore } from './stores/accounts.svelte'

vi.mock('$app/environment', () => ({ browser: false }))
// Isolate from the dev sync/fold subsystems — signBackIn only pokes them.
vi.mock('$lib/dev/sync-hooks', () => ({ triggerSync: vi.fn() }))
vi.mock('$lib/dev/account-refresh', () => ({ noteAccountFolded: vi.fn() }))

// The fold is network I/O — stub it; everything else in the lib stays real.
vi.mock('@snaha/swarm-id', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@snaha/swarm-id')>()),
  foldAccountFromSwarm: vi.fn(),
}))

// `signBackIn`'s fallback probes reachability via `new Bee(url).isConnected()`.
let beeConnected = true
vi.mock('@ethersphere/bee-js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ethersphere/bee-js')>()
  return {
    ...original,
    Bee: class {
      isConnected(): Promise<boolean> {
        return Promise.resolve(beeConnected)
      }
    },
  }
})

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

const PHRASE = 'test test test test test test test test test test test junk'
const wallet = walletFromPhrase(PHRASE)

async function signedInRecord() {
  return {
    id: new EthAddress(wallet.address),
    name: 'Snapshot Account',
    createdAt: 1700000000000,
    derivationKey: await deriveAccountDerivationKey(strip0x(wallet.privateKey)),
    publicKey: strip0x(wallet.publicKey),
    access: { type: 'password', kdfSalt: '00', kdfIterations: 1 } as const,
    encryptedSeed: 'aabbccdd',
    devices: [
      { deviceId: '550e8400-e29b-41d4-a716-446655440000', createdAt: 1, lastSignedInAt: 1 },
    ],
    connectedApps: [
      {
        appUrl: 'https://app.example.com',
        appName: 'Test App',
        lastConnectedAt: 1700000000000,
        appSecret: 'live-session-secret',
        connectedUntil: 4102444800000,
      },
    ],
    postageStamps: [
      {
        batchID: new BatchId('c'.repeat(64)),
        signerKey: new PrivateKey('d'.repeat(64)),
        utilization: 0,
        usable: true,
        depth: 20,
        amount: 100000000n,
        bucketDepth: 16,
        blockNumber: 1,
        immutableFlag: false,
        exists: true,
        createdAt: 1700000000000,
      },
    ],
    defaultPostageStampBatchID: new BatchId('c'.repeat(64)),
    accountNameAt: 1700000001000,
  }
}

/** Sign the freshly-added account out the way the dialog does. */
async function signedOutAccount() {
  const live = accountsStore.add(await signedInRecord())
  live.signOut(await encryptSignOutSnapshot(live))
  return live
}

/** A signed-out remnant whose snapshot cannot decrypt — forces the fallback. */
async function signedOutWithCorruptSnapshot() {
  const { id, name, createdAt, access, encryptedSeed } = await signedInRecord()
  return accountsStore.add({
    id,
    name,
    createdAt,
    access,
    encryptedSeed,
    encryptedState: '{"format":"swarm-id-signout-state","version":1,"salt":"00","payload":"00"}',
    signedOutAt: 1700000000001,
  })
}

beforeEach(() => {
  accountsStore.clear()
  vi.mocked(foldAccountFromSwarm).mockResolvedValue(undefined)
  beeConnected = true
})

describe('sign-out snapshot', () => {
  it('round-trips the synced state and strips live session secrets', async () => {
    const live = accountsStore.add(await signedInRecord())
    const encryptedState = await encryptSignOutSnapshot(live)
    expect(encryptedState).not.toContain('live-session-secret')
    expect(encryptedState).not.toContain(live.derivationKey)

    const restored = await decryptSignOutSnapshot(encryptedState, live.derivationKey)

    expect(restored.postageStamps[0].batchID.toHex()).toBe('c'.repeat(64))
    expect(restored.devices).toHaveLength(1)
    expect(restored.accountNameAt).toBe(1700000001000)
    expect(restored.connectedApps[0].appSecret).toBeUndefined()
    expect(restored.connectedApps[0].connectedUntil).toBeUndefined()
  })

  it('fails to decrypt with a different derivation key', async () => {
    const live = accountsStore.add(await signedInRecord())
    const encryptedState = await encryptSignOutSnapshot(live)

    await expect(decryptSignOutSnapshot(encryptedState, '1'.repeat(64))).rejects.toThrow()
  })
})

describe('signBackIn', () => {
  it('restores from the snapshot without touching the network', async () => {
    const live = await signedOutAccount()
    expect(live.isSignedOut).toBe(true)
    expect(live.postageStamps).toHaveLength(0)

    const restored = await signBackIn(live, wallet.entropy)

    expect(restored).toBe(live) // instance reused in place
    expect(live.isSignedOut).toBe(false)
    expect(live.postageStamps).toHaveLength(1)
    expect(live.defaultPostageStampBatchID?.toHex()).toBe('c'.repeat(64))
    expect(live.devices).toHaveLength(1)
    expect(foldAccountFromSwarm).not.toHaveBeenCalled()
  })

  it('surfaces NoSyncedDataError when the snapshot is corrupt and the network has nothing', async () => {
    const live = await signedOutWithCorruptSnapshot()

    await expect(signBackIn(live, wallet.entropy)).rejects.toBeInstanceOf(NoSyncedDataError)
    expect(live.isSignedOut).toBe(true) // nothing restored
  })

  it('restores a fresh shell only with allowEmpty', async () => {
    const live = await signedOutWithCorruptSnapshot()

    await signBackIn(live, wallet.entropy, { allowEmpty: true })

    expect(live.isSignedOut).toBe(false)
    expect(live.postageStamps).toHaveLength(0)
    expect(live.derivationKey).toHaveLength(64)
  })

  it('throws a retry-able network error when unreachable instead of NoSyncedDataError', async () => {
    const live = await signedOutWithCorruptSnapshot()
    beeConnected = false

    await expect(signBackIn(live, wallet.entropy)).rejects.toThrow(/Swarm network/)
    expect(live.isSignedOut).toBe(true)
  })
})
