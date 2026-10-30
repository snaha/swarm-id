// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The store's boot-time load, which only runs in a browser: a record that
 * still carries a deletion marker is a teardown the page closed on, and the
 * marker is taken back rather than left for the next routine sync to publish.
 */
import { describe, expect, it, vi } from 'vitest'

import { accountsStore } from './accounts.svelte'

vi.mock('$app/environment', () => ({ browser: true }))

const MARKED_AT = 1700000000500

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
  // What the store persists for a signed-in account mid-teardown.
  localStorageStub.setItem(
    'swarm-id-accounts',
    JSON.stringify({
      version: 1,
      data: [
        {
          id: 'a'.repeat(40),
          name: 'Doomed',
          createdAt: 1700000000000,
          derivationKey: 'f'.repeat(64),
          publicKey: '02' + 'ab'.repeat(32),
          devices: [],
          connectedApps: [],
          postageStamps: [],
          deleted: true,
          deletedAt: 1700000000500,
          lastModified: 1700000000500,
          access: { type: 'password', kdfSalt: '00', kdfIterations: 100000 },
          encryptedSeed: 'aabbccdd',
        },
      ],
    }),
  )
})

describe('accounts store load', () => {
  it('takes back a deletion marker left on a stored record', () => {
    const account = accountsStore.get('a'.repeat(40))

    expect(account?.deleted).toBe(false)
    expect(account?.deletedAt).toBeGreaterThan(MARKED_AT)
    const stored = JSON.parse(localStorage.getItem('swarm-id-accounts') ?? '{}') as {
      data: { deleted?: boolean }[]
    }
    expect(stored.data[0].deleted).toBe(false)
  })
})
