// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { parseUnits } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChainIdentity } from '$lib/payment/chain'
import { NATIVE_CURRENCY } from '$lib/payment/payment-rail'

import { quoteDirectPayment, resolveGnosisDirectRail, walletChainRefusal } from './gnosis-direct'

/** Gnosis mainnet's own, as `chain.ts` writes it down. */
const GNOSIS_GENESIS = '0x4f1dd23188aab3a76b463e4af801b52b1248ef073c648cbdc4c9333d3da79756'
/** Any other chain's, which is what a local one has. */
const DEV_GENESIS = '0x' + '11'.repeat(32)
/** A THIRD chain — a wallet left on Ethereum, say. Neither side's own. */
const OTHER_GENESIS = '0x' + '22'.repeat(32)

// Hoisted with the mocks that read them: a factory runs before the module body.
const { RPC_URL, chainIdentity, waitForTransactionSuccess, quoteTokenInForBzzOut } = vi.hoisted(
  () => ({
    RPC_URL: 'https://rpc.gnosischain.com',
    chainIdentity: vi.fn(),
    waitForTransactionSuccess: vi.fn(() => Promise.resolve()),
    quoteTokenInForBzzOut: vi.fn(() => Promise.resolve(0n)),
  }),
)

// The real module for everything but the two probes — `isGnosisMainnetGenesis`
// is the rule under test here, so a stubbed copy would test the stub.
vi.mock('$lib/payment/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/payment/chain')>()),
  chainIdentity,
  postageChain: () => Promise.resolve({ waitForTransactionSuccess, quoteTokenInForBzzOut }),
}))
vi.mock('$lib/stores/network-settings.svelte', () => ({
  networkSettingsStore: { gnosisRpcUrl: RPC_URL },
}))

/** The endpoint as `chainIdentity` reports it — genesis included, since that is
 * the half a wallet is compared against. */
const identity = (
  kind: ChainIdentity['kind'],
  genesisHash = kind === 'mainnet' ? GNOSIS_GENESIS : DEV_GENESIS,
): ChainIdentity => ({ chainId: 100, genesisHash, kind })

afterEach(() => {
  vi.clearAllMocks()
})

function request(xdaiWei: bigint, currency = '0x0000000000000000000000000000000000000000') {
  return {
    chainId: 100,
    currency,
    user: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    recipient: '0x1111111111111111111111111111111111111111',
    xdaiWei,
    bzzPlur: 0n,
    gasXdaiWei: 0n,
  }
}

describe('quoteDirectPayment', () => {
  it('charges exactly what has to arrive — nothing takes a cut', async () => {
    // Nothing takes a cut on the direct path: a quote larger than the delivery
    // would mean a fee or a spread had crept in.
    const xdaiWei = parseUnits('0.06', 18)
    const quote = await quoteDirectPayment(request(xdaiWei))
    expect(quote.amountFormatted).toBe('0.06')
    expect((quote.handle as { amount: bigint }).amount).toBe(xdaiWei)
  })

  it('prices in dollars, because xDAI is one', async () => {
    expect((await quoteDirectPayment(request(parseUnits('1.5', 18)))).amountUsd).toBe('1.50')
  })

  it('carries the recipient through to execution', async () => {
    const { handle } = await quoteDirectPayment(request(parseUnits('0.06', 18)))
    expect((handle as { recipient: string }).recipient).toBe(
      '0x1111111111111111111111111111111111111111',
    )
  })

  it('formats a small amount the way the pay screen renders it', async () => {
    // Shares the rail contract's formatter, so it cannot drift from the
    // breakdown rows beneath it the way an unrounded raw figure would.
    expect(
      (await quoteDirectPayment(request(parseUnits('0.0000434659', 18)))).amountFormatted,
    ).toBe('0.00004347')
  })
})

/**
 * The one guard between a developer's wallet and their own money.
 *
 * Chain id cannot stand in for this: the local chain answers 100 on purpose,
 * so a wallet that already has REAL Gnosis configured accepts the switch
 * without ever seeing the local RPC, and the transfer that follows spends real
 * xDAI at an address only this machine holds the key to.
 */
describe('walletChainRefusal', () => {
  it('lets a payment through when both sides are the SAME chain', () => {
    expect(walletChainRefusal(identity('dev'), DEV_GENESIS, RPC_URL)).toBeUndefined()
    expect(walletChainRefusal(identity('mainnet'), GNOSIS_GENESIS, RPC_URL)).toBeUndefined()
  })

  /**
   * "Not mainnet" is not an identity: a wallet on Ethereum — or on a colleague's
   * chain, or yesterday's anvil — must not pass against a dev endpoint. The
   * transfer goes nowhere either way.
   */
  it('refuses a wallet on a third chain, mainnet or not', () => {
    const refusal = walletChainRefusal(identity('dev'), OTHER_GENESIS, RPC_URL)
    expect(refusal).toMatch(/different chain/)
    expect(refusal).toContain(RPC_URL)
    expect(refusal).toContain('Gnosis Chain (fake)')
  })

  it('names both sides when a real wallet meets a test endpoint', () => {
    const refusal = walletChainRefusal(identity('dev'), GNOSIS_GENESIS, RPC_URL)
    expect(refusal).toMatch(/real Gnosis Chain/)
    expect(refusal).toMatch(/test chain/)
    expect(refusal).toContain(RPC_URL)
    expect(refusal).toContain('Gnosis Chain (fake)')
  })

  it('names both sides when a test wallet meets the real endpoint', () => {
    const refusal = walletChainRefusal(identity('mainnet'), DEV_GENESIS, RPC_URL)
    expect(refusal).toMatch(/test chain/)
    expect(refusal).toMatch(/real Gnosis Chain/)
  })

  it('reads a genesis hash however the wallet cased it', () => {
    expect(
      walletChainRefusal(identity('mainnet'), GNOSIS_GENESIS.toUpperCase(), RPC_URL),
    ).toBeUndefined()
    expect(walletChainRefusal(identity('dev'), DEV_GENESIS.toUpperCase(), RPC_URL)).toBeUndefined()
  })

  /**
   * Silence is not proof. Off mainnet it looks exactly like a real wallet on
   * real Gnosis, which is the case that costs real money, so an unanswerable
   * probe refuses; on mainnet the same silence risks only a payment that does
   * not arrive, so it goes through rather than blocking wallets that do not
   * serve the method.
   */
  it.each([['dev'], ['unsupported']] as const)(
    'refuses a wallet that will not say which chain it is on, off mainnet (%s)',
    (kind) => {
      expect(walletChainRefusal(identity(kind), undefined, RPC_URL)).toMatch(
        /would not say which chain/,
      )
    },
  )

  it('lets an unanswerable wallet pay on proven mainnet', () => {
    expect(walletChainRefusal(identity('mainnet'), undefined, RPC_URL)).toBeUndefined()
  })
})

describe('the direct rail’s execution', () => {
  /** A wallet that answers for `genesisHash`, or refuses the question at all. */
  function wallet(genesisHash: string | undefined) {
    const sent: unknown[][] = []
    const provider = {
      request({ method, params = [] }: { method: string; params?: unknown[] }) {
        if (method === 'eth_getBlockByNumber') {
          return genesisHash === undefined
            ? Promise.reject(new Error('the method eth_getBlockByNumber does not exist'))
            : Promise.resolve({ hash: genesisHash })
        }
        if (method === 'eth_sendTransaction') {
          sent.push(params)
          return Promise.resolve('0x' + 'ab'.repeat(32))
        }
        return Promise.reject(new Error(`unexpected ${method}`))
      },
    }
    return { provider, sent }
  }

  async function pay(provider: { request(args: { method: string }): Promise<unknown> }) {
    const rail = await resolveGnosisDirectRail()
    await rail!.execute({
      quote: await quoteDirectPayment(request(parseUnits('0.06', 18))),
      provider,
      chainId: 100,
      currency: NATIVE_CURRENCY,
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    })
  }

  it('sends once the wallet has proven it is on the same chain', async () => {
    chainIdentity.mockResolvedValue(identity('dev'))
    const { provider, sent } = wallet(DEV_GENESIS)
    await pay(provider)
    expect(sent).toHaveLength(1)
    expect(waitForTransactionSuccess).toHaveBeenCalledOnce()
  })

  /**
   * Nothing may reach the wallet's `eth_sendTransaction` once the two disagree.
   * A refusal after signing would be too late — the xDAI is gone by then,
   * stranded at an address only this machine can spend from.
   */
  it('sends nothing at all when the wallet is on real Gnosis and the app is not', async () => {
    chainIdentity.mockResolvedValue(identity('dev'))
    const { provider, sent } = wallet(GNOSIS_GENESIS)
    await expect(pay(provider)).rejects.toThrow(/real Gnosis Chain/)
    expect(sent).toEqual([])
  })

  it('sends nothing when the wallet will not say and the app is off mainnet', async () => {
    chainIdentity.mockResolvedValue(identity('dev'))
    const { provider, sent } = wallet(undefined)
    await expect(pay(provider)).rejects.toThrow(/would not say which chain/)
    expect(sent).toEqual([])
  })

  /**
   * The rail is resolved when the dialog opens and used minutes later, so the
   * endpoint can stop answering in between. An identity we can no longer prove
   * is not a licence to send: the rejection is the answer.
   */
  it('sends nothing when the app’s own endpoint stops answering before Pay', async () => {
    chainIdentity
      .mockResolvedValueOnce(identity('dev'))
      .mockRejectedValue(new Error('The configured Gnosis RPC answered 429 to eth_chainId.'))
    const { provider, sent } = wallet(DEV_GENESIS)
    await expect(pay(provider)).rejects.toThrow(/configured Gnosis RPC/)
    expect(sent).toEqual([])
  })
})

describe('paying in something other than xDAI', () => {
  const USDC = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83'
  const BZZ = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da'

  /** A wallet that proves the dev chain and records every send, in order. */
  function wallet() {
    const sent: unknown[][] = []
    const provider = {
      request({ method, params = [] }: { method: string; params?: unknown[] }) {
        if (method === 'eth_getBlockByNumber') {
          return Promise.resolve({ hash: DEV_GENESIS })
        }
        if (method === 'eth_sendTransaction') {
          sent.push(params)
          return Promise.resolve('0x' + 'ab'.repeat(32))
        }
        return Promise.reject(new Error(`unexpected ${method}`))
      },
    }
    return { provider, sent }
  }

  /** The four assets, and nothing that has no route to BZZ. */
  it('offers exactly the assets with a pool behind them', async () => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    const rail = await resolveGnosisDirectRail()
    expect(rail!.tokens(100).map((token) => token.symbol)).toEqual(['xDAI', 'WXDAI', 'USDC', 'BZZ'])
    // WETH is deliberately absent: no BZZ/WETH pool exists, and the two-hop
    // alternative runs through pools holding a few hundred dollars.
    expect(rail!.tokens(100).some((token) => token.symbol === 'WETH')).toBe(false)
  })

  /** 9.03 USDC quoted exact-output, +20% — the buffer the xDAI leg gets too. */
  const BUFFERED_USDC = 10_836_000n

  /**
   * Sized from the BZZ the operation needs, NOT by converting the xDAI figure.
   * Converting would price a swap nobody makes and pay the spread twice.
   */
  it('prices a token leg against the pool it will actually swap through', async () => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    quoteTokenInForBzzOut.mockResolvedValue(9_030_000n)
    const rail = await resolveGnosisDirectRail()
    const quote = await rail!.quote({
      ...request(parseUnits('9.04', 18), USDC),
      bzzPlur: 206n * 10n ** 16n,
      gasXdaiWei: parseUnits('0.005', 18),
    })
    expect(quoteTokenInForBzzOut).toHaveBeenCalledWith(206n * 10n ** 16n, 'usdc')
    expect(quote.delivers).toEqual({ input: 'usdc', amount: BUFFERED_USDC })
    expect(quote.amountFormatted).toBe('10.84')
  })

  /**
   * The token leg carries the same headroom the xDAI one does. It is quoted
   * exact-output here and swapped exact-input later, at a price that has moved
   * since — without the buffer any adverse move under-delivers, and the
   * shortfall only shows up once the token has been spent. Exact-input turns the
   * headroom into a little more BZZ instead, which the next funds check eats.
   */
  it('buffers the token leg exactly as the xDAI leg is buffered', async () => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    quoteTokenInForBzzOut.mockResolvedValue(9_030_000n)
    const rail = await resolveGnosisDirectRail()
    const quote = await rail!.quote({
      ...request(parseUnits('9.04', 18), USDC),
      bzzPlur: 206n * 10n ** 16n,
      gasXdaiWei: 0n,
    })
    expect((quote.handle as { amount: bigint }).amount).toBe(BUFFERED_USDC)
  })

  /**
   * The gas is a second transaction, in xDAI, on top of the token — so a total
   * naming only the token leg is short of the bill the user is about to pay.
   * xDAI is a dollar, so the two add directly.
   */
  it('prices the gas leg into the dollar total', async () => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    quoteTokenInForBzzOut.mockResolvedValue(9_030_000n)
    const rail = await resolveGnosisDirectRail()
    const quote = await rail!.quote({
      ...request(parseUnits('9.04', 18), USDC),
      bzzPlur: 206n * 10n ** 16n,
      gasXdaiWei: parseUnits('0.5', 18),
    })
    // 10.836 USDC + 0.5 xDAI.
    expect(quote.amountUsd).toBe('11.34')
  })

  /** BZZ is already what the operation spends, so nothing is quoted at all —
   * and nothing can move against it, so it takes no buffer either. */
  it('asks no pool when the payment is in BZZ', async () => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    const rail = await resolveGnosisDirectRail()
    const quote = await rail!.quote({
      ...request(0n, BZZ),
      bzzPlur: 42n,
      gasXdaiWei: 0n,
    })
    expect(quoteTokenInForBzzOut).not.toHaveBeenCalled()
    expect(quote.delivers).toEqual({ input: 'bzz', amount: 42n })
  })

  /**
   * A shortfall that is only gas has no BZZ leg for a token to buy, and the gas
   * itself is native. Quoting it anyway asks the Sushi quoter for a zero-amount
   * trade, which reverts — and in BZZ it would offer "0 BZZ" with Pay live, one
   * click from a zero-value ERC20 transfer.
   */
  it.each([
    ['WXDAI', '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d'],
    ['USDC', USDC],
    ['BZZ', BZZ],
  ])('refuses in words when only gas is owed and the token is %s', async (_label, token) => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    const rail = await resolveGnosisDirectRail()
    await expect(
      rail!.quote({ ...request(parseUnits('0.005', 18), token), bzzPlur: 0n, gasXdaiWei: 0n }),
    ).rejects.toThrow(/only covers transaction gas/)
    expect(quoteTokenInForBzzOut).not.toHaveBeenCalled()
  })

  /** xDAI is the one asset a gas-only shortfall CAN be paid in: it is the gas. */
  it('still quotes a gas-only shortfall in xDAI', async () => {
    chainIdentity.mockResolvedValue(identity('mainnet'))
    const rail = await resolveGnosisDirectRail()
    const quote = await rail!.quote({
      ...request(parseUnits('0.005', 18)),
      bzzPlur: 0n,
      gasXdaiWei: parseUnits('0.005', 18),
    })
    expect(quote.amountFormatted).toBe('0.005')
  })

  /**
   * Two transactions, gas FIRST. A token cannot pay for its own swap, and
   * landing the token leg before the gas would park value at an address that
   * cannot yet spend it — so a wallet rejection has to cost the cheaper one.
   */
  it('sends the gas leg before the token leg', async () => {
    chainIdentity.mockResolvedValue(identity('dev'))
    quoteTokenInForBzzOut.mockResolvedValue(9_030_000n)
    const { provider, sent } = wallet()
    const rail = await resolveGnosisDirectRail()
    await rail!.execute({
      quote: await rail!.quote({
        ...request(parseUnits('9.04', 18), USDC),
        bzzPlur: 206n * 10n ** 16n,
        gasXdaiWei: parseUnits('0.005', 18),
      }),
      provider,
      chainId: 100,
      currency: USDC,
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    })

    expect(sent).toHaveLength(2)
    const [gasLeg] = sent[0] as [{ to: string; value: string; data?: string }]
    const [tokenLeg] = sent[1] as [{ to: string; value?: string; data: string }]
    // The gas leg is a plain native transfer to the owner.
    expect(gasLeg.to).toBe('0x1111111111111111111111111111111111111111')
    expect(BigInt(gasLeg.value)).toBe(parseUnits('0.005', 18))
    expect(gasLeg.data).toBeUndefined()
    // The token leg is an ERC20 transfer to the token contract, no value.
    expect(tokenLeg.to).toBe(USDC)
    expect(tokenLeg.value).toBeUndefined()
    expect(tokenLeg.data.startsWith('0xa9059cbb')).toBe(true)
  })

  /**
   * The progress card is already up by the time the wallet prompts for the
   * second leg, so it has to say what is being asked for rather than the leg
   * that just confirmed.
   */
  it('says what the second prompt is for, rather than the leg that finished', async () => {
    chainIdentity.mockResolvedValue(identity('dev'))
    quoteTokenInForBzzOut.mockResolvedValue(9_030_000n)
    const { provider } = wallet()
    const statuses: string[] = []
    const rail = await resolveGnosisDirectRail()
    await rail!.execute({
      quote: await rail!.quote({
        ...request(parseUnits('9.04', 18), USDC),
        bzzPlur: 206n * 10n ** 16n,
        gasXdaiWei: parseUnits('0.005', 18),
      }),
      provider,
      chainId: 100,
      currency: USDC,
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      onStatus: (status) => statuses.push(status),
    })
    expect(statuses).toEqual([
      'Confirming the gas for your drive',
      'Approve the payment in your wallet',
      'Confirming your payment',
    ])
  })

  /** Paying in xDAI stays one prompt — the gas rides along in the same send. */
  it('keeps an xDAI payment to a single transaction', async () => {
    chainIdentity.mockResolvedValue(identity('dev'))
    const { provider, sent } = wallet()
    const rail = await resolveGnosisDirectRail()
    await rail!.execute({
      quote: await rail!.quote({
        ...request(parseUnits('0.06', 18)),
        bzzPlur: 5n,
        gasXdaiWei: parseUnits('0.005', 18),
      }),
      provider,
      chainId: 100,
      currency: NATIVE_CURRENCY,
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    })
    expect(sent).toHaveLength(1)
  })
})
