// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { Signature, Wallet } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createWalletKeySource, requestWalletKeySource } from './eth-wallet'

const { connectWallet } = vi.hoisted(() => ({ connectWallet: vi.fn() }))

vi.mock('$lib/crypto/onboard', () => ({ onboard: { connectWallet } }))

/** EIP-1193 provider stub whose personal_sign delegates to `sign`. */
function walletProvider(sign: (message: string) => Promise<string>) {
  return {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      expect(method).toBe('personal_sign')
      return sign(params?.[0] as string)
    }),
  }
}

function connectAs(address: string, provider: unknown) {
  connectWallet.mockResolvedValue([{ accounts: [{ address }], provider }])
}

beforeEach(() => {
  connectWallet.mockReset()
})

describe('createWalletKeySource (new key material)', () => {
  it('rejects a wallet that signs the same message differently', async () => {
    const wallet = Wallet.createRandom()
    const rogue = Wallet.createRandom()
    // A non-RFC-6979 signer returns different bytes on each signing; simulate
    // it by answering the second prompt with a different well-formed ECDSA
    // signature. Trusting it would encrypt the seed under a key the wallet
    // can never re-derive.
    let signs = 0
    const provider = walletProvider((message) =>
      (signs++ === 0 ? wallet : rogue).signMessage(message),
    )
    connectAs(wallet.address, provider)

    await expect(createWalletKeySource()).rejects.toThrow(/different signature each time/)
    expect(provider.request).toHaveBeenCalledTimes(2)
  })

  it('accepts a deterministic wallet and returns the canonical key source', async () => {
    const wallet = Wallet.createRandom()
    let signature: string | undefined
    const provider = walletProvider(async (message) => {
      signature = await wallet.signMessage(message)
      return signature
    })
    // Lowercased address from the provider: the source must checksum it.
    connectAs(wallet.address.toLowerCase(), provider)

    const source = await createWalletKeySource()

    expect(provider.request).toHaveBeenCalledTimes(2)
    expect(source.walletAddress).toBe(wallet.address)
    expect(source.signature).toBe(Signature.from(signature as string).serialized)
  })

  it('rejects a non-recoverable signature before prompting a second time', async () => {
    const wallet = Wallet.createRandom()
    const contractSigner = Wallet.createRandom()
    const provider = walletProvider((message) => contractSigner.signMessage(message))
    connectAs(wallet.address, provider)

    await expect(createWalletKeySource()).rejects.toThrow(/not supported/)
    expect(provider.request).toHaveBeenCalledTimes(1)
  })
})

describe('requestWalletKeySource (unlock)', () => {
  it('signs once and matches the key source minted at creation', async () => {
    const wallet = Wallet.createRandom()
    const created = walletProvider((message) => wallet.signMessage(message))
    connectAs(wallet.address, created)
    const source = await createWalletKeySource()

    const unlocked = walletProvider((message) => wallet.signMessage(message))
    connectAs(wallet.address, unlocked)
    const unlockSource = await requestWalletKeySource()

    expect(unlocked.request).toHaveBeenCalledTimes(1)
    expect(unlockSource).toEqual(source)
  })
})
