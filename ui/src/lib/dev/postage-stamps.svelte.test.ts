// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression: the runtime stamper follows a recorded depth change.
 *
 * A dilute records the new depth on the stamp (`Account.updateStamp`, the
 * resize dialog's write); every upload after it must stamp against the WIDER
 * batch. `getStamper()` builds a fresh `UtilizationAwareStamper` per call
 * today, so it follows along incidentally — nothing pins it, and a caching
 * optimisation would hand back an instance frozen at the pre-dilute depth.
 *
 * The assertions are therefore on the stamper's own depth-derived state, not
 * on the depth passed to it: `maxSlot` (`2^(depth - bucketDepth)`, the
 * per-bucket slot budget the inner bee-js stamper enforces) and the
 * utilization state's `batchDepth` (which picks the on-disk chunk layout).
 * A stale cached stamper fails on those.
 */
import { BatchId, EthAddress, PrivateKey } from '@ethersphere/bee-js'
import type { Account as AccountRecord, PostageStamp } from '@snaha/swarm-id'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { accountsStore } from '$lib/stores/accounts.svelte'

import { postageStampsStore } from './postage-stamps.svelte'

// `getStamper` refuses to build the IndexedDB-backed utilization store outside
// the browser, so the store module has to load as if it were in one — which in
// turn makes the accounts store read `window.localStorage` at import time.
vi.mock('$app/environment', () => ({ browser: true }))

// Node has no IndexedDB; stub the utilization cache the stamper opens at
// construction so it starts from fresh counters (`create()` would otherwise
// warn its way through a failed open). Everything else — the stamper itself
// included — stays real, since the depth assertions ride on it.
vi.mock('@snaha/swarm-id', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@snaha/swarm-id')>()),
  UtilizationStoreDB: class {
    getAllChunks = async () => []
    putChunk = async () => undefined
  },
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

const ACCOUNT_ID_HEX = 'a'.repeat(40)
const BATCH_ID = new BatchId('c'.repeat(64))

/** Bee's fixed bucket depth: a batch holds `2^(depth - 16)` slots per bucket. */
const BUCKET_DEPTH = 16
const INITIAL_DEPTH = 20
/** Post-dilute depth — 4× the slots per bucket, so `maxSlot` moves visibly. */
const DILUTED_DEPTH = 22

const STAMPER_OPTIONS = {
  owner: new EthAddress(ACCOUNT_ID_HEX),
  encryptionKey: new Uint8Array(32).fill(1),
}

function stamp(): PostageStamp {
  return {
    batchID: BATCH_ID,
    signerKey: new PrivateKey('d'.repeat(64)),
    utilization: 0,
    usable: true,
    depth: INITIAL_DEPTH,
    amount: 100000000n,
    bucketDepth: BUCKET_DEPTH,
    blockNumber: 1,
    immutableFlag: false,
    exists: true,
    createdAt: 1,
  }
}

function record(): AccountRecord {
  return {
    id: new EthAddress(ACCOUNT_ID_HEX),
    name: 'test',
    createdAt: 1,
    derivationKey: 'f'.repeat(64),
    publicKey: '02' + 'ab'.repeat(32),
    access: { type: 'password', kdfSalt: 'a'.repeat(32), kdfIterations: 1 },
    encryptedSeed: 'ab'.repeat(44),
    devices: [],
    connectedApps: [],
    postageStamps: [stamp()],
  }
}

beforeEach(() => {
  accountsStore.clear()
})

describe('getStamper after a dilute', () => {
  it('stamps against the new depth once the stamp records it', async () => {
    const account = accountsStore.add(record())

    const before = await postageStampsStore.getStamper(BATCH_ID, STAMPER_OPTIONS)
    expect(before?.depth).toBe(INITIAL_DEPTH)
    expect(before?.maxSlot).toBe(2 ** (INITIAL_DEPTH - BUCKET_DEPTH))

    account.updateStamp(BATCH_ID, { depth: DILUTED_DEPTH })

    const after = await postageStampsStore.getStamper(BATCH_ID, STAMPER_OPTIONS)
    expect(after?.depth).toBe(DILUTED_DEPTH)
    expect(after?.maxSlot).toBe(2 ** (DILUTED_DEPTH - BUCKET_DEPTH))
    expect(after?.getUtilizationState().batchDepth).toBe(DILUTED_DEPTH)
  })
})
