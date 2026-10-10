// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { defineChain } from 'viem'
import { base, gnosis, mainnet } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type EthereumProvider,
  displayAmount,
  displayUsd,
  isUnrecognizedChainError,
  startingChainId,
  switchWalletChain,
  walletChainId,
} from '$lib/payment/payment-rail'

/**
 * The two figures the pay screen stacks on top of each other, and the same
 * `displayUsd` the drive dialogs price their estimate with. Rails hand back
 * wildly different precision, so what they render is decided here, not there.
 */
describe('displayAmount', () => {
  it('cuts a rail’s raw precision down to significant digits', () => {
    // Relay's `amountFormatted` for a native token, verbatim.
    expect(displayAmount('0.000043465998997394')).toBe('0.00004347')
  })

  it('drops the zeros toPrecision pads back on', () => {
    expect(displayAmount('1.5')).toBe('1.5')
    expect(displayAmount(2)).toBe('2')
  })

  /**
   * Padding is only ever after a decimal point: a four-significant-digit integer
   * keeps its REAL zeros, so 1230 must not render as 123 — an order of magnitude
   * off, in a figure the user is about to pay.
   */
  it('keeps the zeros that are part of the number', () => {
    expect(displayAmount(1230)).toBe('1230')
    expect(displayAmount(1000)).toBe('1000')
    expect(displayAmount(9990)).toBe('9990')
  })

  it('has nothing to show for a non-figure or a non-positive one', () => {
    expect(displayAmount('')).toBe('')
    expect(displayAmount('nonsense')).toBe('')
    expect(displayAmount(0)).toBe('')
    expect(displayAmount(-1)).toBe('')
  })

  /**
   * `toPrecision` reaches for exponential notation outside a narrow middle
   * band — at four significant digits, from 10000 up and below 1e-7 — and the
   * pay screen renders whatever comes back verbatim. "1.235e+4" is not a price
   * anyone can read, and next to a token symbol it invites reading the
   * exponent as part of the amount.
   */
  it('never falls back to exponential notation', () => {
    expect(displayAmount(12345)).toBe('12350')
    expect(displayAmount(123456789)).toBe('123500000')
    expect(displayAmount(0.0000000025)).toBe('0.0000000025')
    expect(displayAmount('0.000000000000000001')).toBe('0.000000000000000001')
  })
})

describe('displayUsd', () => {
  it('shows cents for ordinary figures', () => {
    expect(displayUsd(1.5852)).toBe('1.59')
    expect(displayUsd('0.17')).toBe('0.17')
    expect(displayUsd(7.048359592682033)).toBe('7.05')
  })

  /**
   * A small drive genuinely costs a fraction of a cent to extend, so cents
   * alone would render a real price as "0.00" — free, rather than cheap.
   */
  it('shows significant digits below a cent', () => {
    expect(displayUsd(0.0034)).toBe('0.0034')
    expect(displayUsd(0.00012)).toBe('0.00012')
    expect(displayUsd(0.0005)).toBe('0.0005')
  })

  /**
   * A rail whose source could not price the payment passes `''` rather than
   * inventing a figure — Relay's `currencyIn` is optional, so `relay.ts` does.
   * Formatted as '0.00' it would read as "~0.00 USD total" under a blank cost
   * line; empty is what every caller renders behind a truthiness test.
   */
  it('has nothing to show for a missing or non-positive figure', () => {
    expect(displayUsd('')).toBe('')
    expect(displayUsd('nonsense')).toBe('')
    expect(displayUsd(0)).toBe('')
    expect(displayUsd(-1)).toBe('')
  })

  /**
   * Two significant digits put `toPrecision`'s exponential threshold at a
   * hundredth of a cent — well inside the range a per-day drive cost lands in
   * — so "$1.0e-8" was a figure the cost line could genuinely reach.
   */
  it('spells a very small dollar figure out rather than exponentiating it', () => {
    expect(displayUsd(0.00000001)).toBe('0.00000001')
    expect(displayUsd(0.0000000025)).toBe('0.0000000025')
  })
})

/**
 * The switch-chain failure that deserves an add-network prompt, told apart
 * from every other one. Fixtures are literal, because the shapes are what real
 * providers really send — the point is the wrapping, not the reading.
 */
describe('isUnrecognizedChainError', () => {
  it('takes EIP-1193’s own code, where a browser extension puts it', () => {
    expect(isUnrecognizedChainError({ code: 4902, message: 'Unrecognized chain ID' })).toBe(true)
  })

  /**
   * MetaMask over WalletConnect: the relay reports its own generic "internal
   * error" and keeps the provider's answer a level down.
   */
  it('digs the code out of a relay’s internal-error wrapper', () => {
    expect(
      isUnrecognizedChainError({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { originalError: { code: 4902 } },
      }),
    ).toBe(true)
    expect(isUnrecognizedChainError({ code: -32603, data: { code: 4902 } })).toBe(true)
  })

  it('falls back to the message when the code was lost entirely', () => {
    expect(isUnrecognizedChainError(new Error('Unrecognized chain ID. Try adding it first.'))).toBe(
      true,
    )
  })

  /**
   * A user's own "no" is never an unrecognised chain, however it is wrapped.
   * Answering it with an add-network dialog would be the app arguing with a
   * decision they just made.
   */
  it('never reads a user’s rejection as a missing chain', () => {
    expect(isUnrecognizedChainError({ code: 4001, message: 'User rejected the request.' })).toBe(
      false,
    )
    expect(
      isUnrecognizedChainError({ code: -32603, data: { originalError: { code: 4001 } } }),
    ).toBe(false)
  })

  it('leaves an unrelated failure alone', () => {
    expect(isUnrecognizedChainError(new Error('Network request failed'))).toBe(false)
    expect(isUnrecognizedChainError({ code: -32000, message: 'insufficient funds' })).toBe(false)
    expect(isUnrecognizedChainError(undefined)).toBe(false)
  })

  /**
   * The message fallback used to be a bare `4902` and `not.*added`, which
   * matched those patterns anywhere in the string — a chain id like 49020, a
   * gas figure, an address fragment, or any unrelated "not ... added"
   * pairing. None of those are a wallet saying it doesn't know the chain, and
   * answering them with wallet_addEthereumChain is an unrequested prompt.
   */
  it('does not read "4902" inside an unrelated number as a missing chain', () => {
    expect(
      isUnrecognizedChainError({
        code: -32000,
        message: 'insufficient funds: chain 49020 gas too low',
      }),
    ).toBe(false)
  })

  it('does not read an unrelated "not ... added" as a missing chain', () => {
    expect(
      isUnrecognizedChainError({
        code: -32000,
        message: 'This feature has not been added to your plan.',
      }),
    ).toBe(false)
  })
})

/**
 * Getting the wallet onto the chain the payment will be signed on — which is
 * not the same as the wallet having heard of it.
 */
describe('switchWalletChain', () => {
  const GNOSIS_HEX = '0x64'

  /** A wallet that knows no chains until one is added, recording every call. */
  function wallet(knownChains: string[]) {
    const known = new Set(knownChains)
    const calls: string[] = []
    const provider = {
      request({ method, params = [] }: { method: string; params?: unknown[] }) {
        calls.push(method)
        const [argument] = params as [{ chainId: string }]
        if (method === 'wallet_switchEthereumChain' && !known.has(argument.chainId)) {
          return Promise.reject({ code: 4902, message: 'Unrecognized chain ID' })
        }
        if (method === 'wallet_addEthereumChain') {
          known.add(argument.chainId)
        }
        return Promise.resolve(undefined)
      },
    }
    return { provider, calls }
  }

  it('asks once when the wallet already knows the chain', async () => {
    const { provider, calls } = wallet([GNOSIS_HEX])
    await switchWalletChain(provider, gnosis.id, [gnosis])
    expect(calls).toEqual(['wallet_switchEthereumChain'])
  })

  /**
   * Adding a network is not being on it. Several wallets add without switching,
   * and the payment would then be signed on whatever chain was there before —
   * which the local and the real Gnosis both answer to as chain id 100.
   */
  it('switches again after adding the chain', async () => {
    const { provider, calls } = wallet([])
    await switchWalletChain(provider, gnosis.id, [gnosis])
    expect(calls).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ])
  })

  it('fails the way a refused switch does when the second one is declined', async () => {
    const declined = { code: 4001, message: 'User rejected the request.' }
    const request = vi
      .fn()
      .mockRejectedValueOnce({ code: 4902, message: 'Unrecognized chain ID' })
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(declined)
    await expect(switchWalletChain({ request }, gnosis.id, [gnosis])).rejects.toBe(declined)
  })
})

/**
 * The switch's genesis verification. Two networks can share a chain id — the
 * real Gnosis and the local chain wearing its id on purpose — and the id is
 * all `wallet_switchEthereumChain` can name: a wallet with the other one
 * configured satisfies the switch without ever seeing our RPC. A chain
 * carrying an expected genesis is therefore checked through the wallet, and a
 * proven mismatch is repaired by offering the chain again — the one request
 * that makes a wallet adopt OUR endpoint for an id it already serves.
 */
describe('switchWalletChain — two networks, one chain id', () => {
  const OUR_GENESIS = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'
  const OTHER_GENESIS = `0x${'ab'.repeat(32)}`

  const fakeGnosis = defineChain({
    id: 100,
    name: 'Gnosis Chain (fake)',
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost:9545'] } },
    custom: { genesisHash: OUR_GENESIS },
  })

  /** A wallet already serving chain 100, on the network `genesis` names. */
  function walletOn(behaviour: { genesis: string | undefined; adoptOnAdd?: boolean }) {
    const calls: string[] = []
    const provider = {
      request({ method }: { method: string; params?: unknown[] }) {
        calls.push(method)
        if (method === 'eth_getBlockByNumber') {
          return Promise.resolve(
            behaviour.genesis === undefined ? undefined : { hash: behaviour.genesis },
          )
        }
        if (method === 'wallet_addEthereumChain' && behaviour.adoptOnAdd) {
          behaviour.genesis = OUR_GENESIS
        }
        return Promise.resolve(undefined)
      },
    }
    return { provider, calls }
  }

  it('accepts a wallet whose genesis matches, without offering the chain', async () => {
    const { provider, calls } = walletOn({ genesis: OUR_GENESIS })
    await switchWalletChain(provider, fakeGnosis.id, [fakeGnosis])
    expect(calls).toEqual(['wallet_switchEthereumChain', 'eth_getBlockByNumber'])
  })

  it('repairs a wallet that landed on the other network wearing the id', async () => {
    const { provider, calls } = walletOn({ genesis: OTHER_GENESIS, adoptOnAdd: true })
    await switchWalletChain(provider, fakeGnosis.id, [fakeGnosis])
    expect(calls).toContain('wallet_addEthereumChain')
  })

  it('refuses in words when the wallet stays put after the offer', async () => {
    const { provider } = walletOn({ genesis: OTHER_GENESIS })
    await expect(switchWalletChain(provider, fakeGnosis.id, [fakeGnosis])).rejects.toThrow(
      /Remove that network/,
    )
  })

  /**
   * MetaMask does not adopt an RPC for an id it already serves — the offer
   * fails with "network already exists". That failure is part of the verdict,
   * not an error of ours: the user must hear what to do about it, not a
   * wallet's internals.
   */
  it('turns a refused offer into the same worded verdict', async () => {
    const { provider } = walletOn({ genesis: OTHER_GENESIS })
    const request = provider.request.bind(provider)
    provider.request = (args: { method: string; params?: unknown[] }) =>
      args.method === 'wallet_addEthereumChain'
        ? Promise.reject(new Error('May not specify a chain that already exists'))
        : request(args)
    await expect(switchWalletChain(provider, fakeGnosis.id, [fakeGnosis])).rejects.toThrow(
      /Remove that network/,
    )
  })

  it('leaves a silent wallet to the payer check rather than repairing blind', async () => {
    const { provider, calls } = walletOn({ genesis: undefined })
    await switchWalletChain(provider, fakeGnosis.id, [fakeGnosis])
    expect(calls).not.toContain('wallet_addEthereumChain')
  })

  it('never probes a chain that carries no expected genesis', async () => {
    const { provider, calls } = walletOn({ genesis: OTHER_GENESIS })
    await switchWalletChain(provider, gnosis.id, [gnosis])
    expect(calls).toEqual(['wallet_switchEthereumChain'])
  })
})

/**
 * Where the pay screen opens. A wallet already on a chain the payment can come
 * from is where its funds most likely are; sending it somewhere else before
 * the user has chosen anything is how a wallet holding only ETH was walked to
 * Gnosis and offered a payment in xDAI it did not have.
 */
describe('startingChainId', () => {
  it('opens on the wallet’s own chain when the payment can come from it', () => {
    expect(startingChainId(base.id, [gnosis, mainnet, base], gnosis.id)).toBe(base.id)
  })

  /** What is already selected decides only when the wallet's chain is no help. */
  it('keeps the selection when the wallet’s chain is not one on offer', () => {
    expect(startingChainId(mainnet.id, [gnosis, base], gnosis.id)).toBe(gnosis.id)
  })

  it('keeps the selection when the wallet would not say', () => {
    expect(startingChainId(undefined, [gnosis, mainnet], gnosis.id)).toBe(gnosis.id)
  })

  /**
   * A wallet changed mid-payment: the user already picked a chain, and a
   * wallet with nothing to say about it must not throw that pick away for the
   * rails' default.
   */
  it('keeps a chain the user picked over the rails’ default', () => {
    expect(startingChainId(mainnet.id, [gnosis, base], base.id)).toBe(base.id)
  })
})

/**
 * The chain the wallet is on, read without asking anyone anything. Whatever
 * cannot be read as a chain id is "no answer", never a guess: the caller falls
 * back to its default and offers the switch it always did.
 */
describe('walletChainId', () => {
  /** Long enough for any wallet that is ever going to answer. */
  const SILENCE_MS = 10_000

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A wallet answering `eth_chainId` with `answer`, recording what it is asked. */
  function answering(answer: unknown) {
    const calls: string[] = []
    const provider: EthereumProvider = {
      request({ method }) {
        calls.push(method)
        return Promise.resolve(answer)
      },
    }
    return { provider, calls }
  }

  it('reads the hex chain id the wallet reports', async () => {
    const { provider, calls } = answering('0x64')
    expect(await walletChainId(provider)).toBe(gnosis.id)
    // The one question a wallet answers from its own state, with no prompt.
    expect(calls).toEqual(['eth_chainId'])
  })

  it('is no answer when the wallet refuses the question', async () => {
    const provider: EthereumProvider = {
      request: () => Promise.reject(new Error('the method eth_chainId does not exist')),
    }
    expect(await walletChainId(provider)).toBeUndefined()
  })

  it.each([['garbage'], [''], ['0x'], ['0xzz'], [gnosis.id], [undefined], [{}]])(
    'is no answer when the wallet says something that is not a hex chain id (%s)',
    async (answer) => {
      expect(await walletChainId(answering(answer).provider)).toBeUndefined()
    },
  )

  /** Connect waits on this read, so a wallet that never answers must not hold it. */
  it('gives up on a wallet that never answers', async () => {
    vi.useFakeTimers()
    const provider: EthereumProvider = { request: () => new Promise(() => undefined) }
    const reading = walletChainId(provider)
    await vi.advanceTimersByTimeAsync(SILENCE_MS)
    await expect(reading).resolves.toBeUndefined()
  })
})
