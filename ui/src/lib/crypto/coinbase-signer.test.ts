// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { COINBASE_SIGNER_TYPE_KEY, forgetCoinbaseSmartWallet } from './coinbase-signer'

function storageWith(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
  }
}

describe('forgetCoinbaseSmartWallet', () => {
  it('forgets a saved Smart Wallet signer', () => {
    const storage = storageWith({ [COINBASE_SIGNER_TYPE_KEY]: 'scw' })

    forgetCoinbaseSmartWallet(storage)

    expect(storage.map.has(COINBASE_SIGNER_TYPE_KEY)).toBe(false)
  })

  it.each(['walletlink', 'extension'])('keeps a saved %s signer', (signerType) => {
    const storage = storageWith({ [COINBASE_SIGNER_TYPE_KEY]: signerType })

    forgetCoinbaseSmartWallet(storage)

    expect(storage.map.get(COINBASE_SIGNER_TYPE_KEY)).toBe(signerType)
  })

  it('does nothing when no signer was saved', () => {
    const storage = storageWith({})

    forgetCoinbaseSmartWallet(storage)

    expect(storage.map.size).toBe(0)
  })
})
