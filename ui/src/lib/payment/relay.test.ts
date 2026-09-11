// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The rail's own failure bound, and the table the picker is built from.
 * Relay's pricing and step model are contract-tested against the live API in
 * `relay.live.test.ts`; what cannot be observed there is an SDK that simply
 * never comes back, which is what this covers.
 */
import { TimeoutError } from '@snaha/swarm-id'
import { gnosisMainnetSettings } from '@swarm-id/multichain'
import { gnosis } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type EthereumProvider, NATIVE_CURRENCY, WALLET_CHAINS } from '$lib/payment/payment-rail'

import { PAYMENT_TOKENS, relayRail } from './relay'

/** As much of the SDK's progress report as this rail reads. */
interface Progress {
  currentStep?: { id?: string }
  currentStepItem?: { progressState?: string }
}
interface ExecuteOptions {
  onProgress: (progress: Progress) => void
}

/** An `execute` that accepts the payment and then goes quiet forever. */
const execute = vi.fn((_options: ExecuteOptions) => new Promise<void>(() => undefined))
/** A `getQuote` that never prices anything. */
const getQuote = vi.fn(() => new Promise<never>(() => undefined))

/** As much of the SDK's client as the rail configures. */
interface Client {
  source?: string
  chains?: { id: number }[]
}
/** The one client the SDK hands out, so what the rail left on it can be read. */
const client: Client & { actions: { execute: typeof execute; getQuote: typeof getQuote } } = {
  actions: { execute, getQuote },
}
/**
 * The SDK's own fallback, mirrored: given no source it takes the page's
 * hostname — which is a referrer like any other, and the same 401. Without this
 * a rail that simply omitted the source would pass the test below while failing
 * in a browser.
 */
const HOSTNAME_SOURCE = 'localhost'
const createClient = vi.fn((options: Client) => {
  client.source = options.source || HOSTNAME_SOURCE
  client.chains = options.chains
  return client
})

// Every value here is reached through a closure: the factory is hoisted above
// the declarations above it, so naming one directly reads it before it exists.
vi.mock('@relayprotocol/relay-sdk', () => ({
  MAINNET_RELAY_API: 'https://api.relay.link',
  convertViemChainToRelayChain: (chain: { id: number }) => ({ id: chain.id }),
  createClient: (options: Client) => createClient(options),
  getClient: () => client,
}))

const TEN_MINUTES_MS = 600_000
const THIRTY_SECONDS_MS = 30_000

function payFrom(
  chainId: number,
  currency: string,
  provider: EthereumProvider,
  onStatus?: (status: string) => void,
) {
  return relayRail.execute({
    quote: {
      handle: {},
      amountFormatted: '0.001',
      amountUsd: '0.01',
      delivers: { input: 'xdai', amount: 0n },
    },
    provider,
    chainId,
    currency,
    address: '0xpayer',
    onStatus,
  })
}

/** From Base, with a wallet that has nothing to say. */
function pay(onStatus?: (status: string) => void) {
  return payFrom(8453, NATIVE_CURRENCY, { request: () => Promise.resolve(undefined) }, onStatus)
}

describe('relay execute', () => {
  afterEach(() => {
    vi.useRealTimers()
    execute.mockReset()
    execute.mockImplementation(() => new Promise<void>(() => undefined))
  })

  it('fails the payment when the SDK stops reporting, rather than spinning forever', async () => {
    vi.useFakeTimers()
    const payment = pay()
    const rejected = expect(payment).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
    await rejected
    // The user is told it may have landed — the retry re-prices against the
    // owner address rather than assuming the money stayed put.
    await expect(payment).rejects.toThrow(/may still land/)
  })

  /** The deadline bounds silence, not the payment: signing runs at a person's
   * own pace, and a total deadline would fail a payment already in flight. */
  it('does not give up on a payment that keeps reporting, however long it takes', async () => {
    vi.useFakeTimers()
    let finish = () => undefined as void
    execute.mockImplementation(
      (options) =>
        new Promise<void>((resolve) => {
          finish = () => resolve()
          // A report every nine minutes — inside the deadline, but an hour of
          // them is six times it.
          const tick = (remaining: number) => {
            if (remaining === 0) {
              return
            }
            setTimeout(() => {
              options.onProgress({ currentStep: { id: 'deposit' } })
              tick(remaining - 1)
            }, TEN_MINUTES_MS - 60_000)
          }
          tick(6)
        }),
    )
    const payment = pay()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS * 6)
    finish()
    await expect(payment).resolves.toBeUndefined()
  })

  it('gives up once the reports stop, counting from the last one', async () => {
    vi.useFakeTimers()
    execute.mockImplementation(
      (options) =>
        new Promise<void>(() => {
          setTimeout(
            () => options.onProgress({ currentStep: { id: 'deposit' } }),
            TEN_MINUTES_MS - 1,
          )
        }),
    )
    const payment = pay()
    const rejected = expect(payment).rejects.toBeInstanceOf(TimeoutError)
    // Past the original deadline, which the report pushed back...
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
    // ...and then a full deadline of silence after it.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS)
    await rejected
  })

  /** Relay's `action` is its own widget copy; what the card says is ours. */
  it('reports its own wording for a step, never the SDK’s', async () => {
    const reported: string[] = []
    execute.mockImplementation((options) => {
      options.onProgress({
        currentStep: { id: 'approve' },
        currentStepItem: { progressState: 'confirming' },
      })
      options.onProgress({
        currentStep: { id: 'deposit' },
        currentStepItem: { progressState: 'confirming' },
      })
      // The deposit is in and the solver is filling: the delivery leg.
      options.onProgress({
        currentStep: { id: 'deposit' },
        currentStepItem: { progressState: 'validating' },
      })
      // An EIP-5792 wallet signs approve and deposit together under a renamed
      // step. One prompt, and it is the payment — not the delivery leg.
      options.onProgress({
        currentStep: { id: 'approve-and-deposit' },
        currentStepItem: { progressState: 'confirming' },
      })
      // An unknown signature step still knows what `signing` means.
      options.onProgress({
        currentStep: { id: 'some-future-step' },
        currentStepItem: { progressState: 'signing' },
      })
      // And with no state at all it is described rather than quoted.
      options.onProgress({ currentStep: { id: 'some-future-step' } })
      return Promise.resolve()
    })
    await pay((status) => reported.push(status))
    expect(reported).toEqual([
      'Confirming the approval',
      'Confirming your payment',
      'Cross-swap xDAI on Relay',
      'Confirming your payment',
      'Confirm the payment in your wallet',
      'Cross-swap xDAI on Relay',
    ])
  })
})

/**
 * Relay serves the real Gnosis and no other network by that id, and the chain
 * id is all viem's wallet client asserts — 100 == 100 on a local chain wearing
 * it. The dialog's own switch probes genesis, but skips itself when the wallet
 * is recorded as already there, so the rail proves the chain itself before it
 * signs, as the direct rail does on its path.
 */
describe('a Gnosis source', () => {
  const GNOSIS_GENESIS = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'
  const OTHER_GENESIS = `0x${'ab'.repeat(32)}`
  /** The one Gnosis token this rail carries; xDAI there goes to the direct rail. */
  const USDC_E = PAYMENT_TOKENS[gnosis.id].find((token) => token.address !== NATIVE_CURRENCY)!

  /** A wallet answering for `genesis`, or refusing the question; every request counted. */
  function walletOn(genesis: string | undefined) {
    const calls: string[] = []
    const provider: EthereumProvider = {
      request({ method }) {
        calls.push(method)
        if (method === 'eth_getBlockByNumber') {
          return genesis === undefined
            ? Promise.reject(new Error('the method eth_getBlockByNumber does not exist'))
            : Promise.resolve({ hash: genesis })
        }
        return Promise.resolve(undefined)
      },
    }
    return { provider, calls }
  }

  afterEach(() => {
    execute.mockReset()
    execute.mockImplementation(() => new Promise<void>(() => undefined))
  })

  it('signs nothing on a network that only wears Gnosis’s chain id', async () => {
    execute.mockResolvedValue(undefined)
    const { provider } = walletOn(OTHER_GENESIS)
    await expect(payFrom(gnosis.id, USDC_E.address, provider)).rejects.toThrow(/real Gnosis Chain/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('pays once the wallet has proven it is on the real one', async () => {
    execute.mockResolvedValue(undefined)
    const { provider } = walletOn(GNOSIS_GENESIS)
    await payFrom(gnosis.id, USDC_E.address, provider)
    expect(execute).toHaveBeenCalledOnce()
  })

  /** As `walletChainRefusal` rules on mainnet: what silence risks is a deposit
   * on a chain Relay never watches, and no real money moves on one. */
  it('lets a wallet that would not say pay', async () => {
    execute.mockResolvedValue(undefined)
    const { provider } = walletOn(undefined)
    await payFrom(gnosis.id, USDC_E.address, provider)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('asks no other source chain for its genesis', async () => {
    execute.mockResolvedValue(undefined)
    const { provider, calls } = walletOn(OTHER_GENESIS)
    await payFrom(8453, NATIVE_CURRENCY, provider)
    expect(calls).not.toContain('eth_getBlockByNumber')
  })
})

describe('relay quote', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a price rather than leaving the pay screen spinning', async () => {
    vi.useFakeTimers()
    const priced = relayRail.quote({
      chainId: 8453,
      currency: NATIVE_CURRENCY,
      user: '0xpayer',
      recipient: '0xowner',
      xdaiWei: 60_000_000_000_000_000n,
      bzzPlur: 1_000_000_000n,
      gasXdaiWei: 1_000_000_000_000_000n,
    })
    const rejected = expect(priced).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_MS)
    await rejected
    // Nothing has been signed at this point, so the user is simply asked to try
    // again rather than warned about money in flight.
    await expect(priced).rejects.toThrow(/try again/)
  })
})

/**
 * What the rail leaves on the SDK's client, which is what every request it
 * makes carries.
 */
describe('the relay client', () => {
  /** Ask for a price, to make the rail build its client. The quote itself never
   * comes back (the mock above), and is not what this is about. */
  function configureClient() {
    void relayRail
      .quote({
        chainId: 8453,
        currency: NATIVE_CURRENCY,
        user: '0xpayer',
        recipient: '0xowner',
        xdaiWei: 60_000_000_000_000_000n,
        bzzPlur: 1_000_000_000n,
        gasXdaiWei: 1_000_000_000_000_000n,
      })
      .catch(() => undefined)
  }

  /**
   * The regression: Relay answers a quote that names a referrer with 401
   * "Please provide an api key", so a source left on the client is every
   * payment failing at the price screen.
   */
  it('names no source, since a quote that names one needs an api key', () => {
    configureClient()
    expect(client.source).toBeUndefined()
  })

  /** Without these the SDK knows Ethereum alone, and polls a deposit's receipt
   * through the wallet — a WalletConnect round-trip every few seconds. */
  it('declares every chain a payment can be signed on', () => {
    configureClient()
    expect(client.chains?.map((chain) => chain.id)).toEqual(WALLET_CHAINS.map((chain) => chain.id))
  })

  /** One client per page: the SDK keeps a singleton, and a second `createClient`
   * would reconfigure it — putting the source back. */
  it('is built once', () => {
    configureClient()
    configureClient()
    expect(createClient).toHaveBeenCalledTimes(1)
  })
})

/**
 * Two rails serve Gnosis (`resolve-rail.ts`) and both offer a dollar token
 * there, on different contracts — so the picker shows both rows.
 */
describe('the Gnosis token table', () => {
  const stablecoin = PAYMENT_TOKENS[gnosis.id].find((token) => token.address !== NATIVE_CURRENCY)

  it('is a different contract from the one the direct rail transacts in', () => {
    expect(stablecoin?.address).not.toBe(gnosisMainnetSettings().addresses.usdc.toLowerCase())
  })

  /** Pinned against the symbol `gnosis-direct.ts` gives its own USDC: both
   * rows reading "USDC" sends a holder to the rail that shows no balance. */
  it('is named apart from it', () => {
    expect(stablecoin?.symbol).not.toBe('USDC')
  })
})
