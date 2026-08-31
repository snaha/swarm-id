// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-chain payment leg via Relay Protocol — the same rail the Swarm
 * multichain widget uses, driven from our own UI instead of a popup.
 *
 * The user's wallet signs ONE transaction on the source chain; Relay delivers
 * native xDAI to the batch-owner address on Gnosis. Everything after that
 * (swap to BZZ, approve, topUp, increaseDepth) is signed locally by the owner
 * key — see drive-operation.ts.
 *
 * This is the production rail. It cannot run against a local chain: the quote
 * comes from Relay's hosted API, which resolves chains against its own
 * registry, and the delivery is an off-chain solver paying out of its own
 * inventory on real Gnosis. See `payment-rail.ts` for what stands in locally.
 */
import { type Execute, MAINNET_RELAY_API, createClient, getClient } from '@relayprotocol/relay-sdk'
import { withTimeout } from '@snaha/swarm-id'
import { createWalletClient, custom, defineChain } from 'viem'
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from 'viem/chains'

import {
  type EthereumProvider,
  type ExecutePaymentOptions,
  NATIVE_CURRENCY,
  type PaymentQuote,
  type PaymentRail,
  type PaymentToken,
  type QuoteRequest,
  WALLET_CHAINS,
  displayAmount,
  displayUsd,
} from '$lib/payment/payment-rail'

const GNOSIS_CHAIN_ID = 100

/**
 * Ceiling on one delivery, counted from the wallet prompt: signing, the source
 * transaction's confirmations and the solver's payout on Gnosis. Deliberately
 * far past a slow cross-chain delivery (seconds to a couple of minutes) — it
 * exists only so an SDK that stops reporting altogether surfaces as a failed
 * payment instead of a spinner with no way out. A timeout here is not proof the
 * money stayed put, so the retry re-prices against the owner address before
 * asking for anything again (`payment-dialog.svelte`).
 */
const EXECUTE_TIMEOUT_MS = 600_000

/**
 * Ceiling on pricing one route. Nothing is signed and nothing moves yet, so a
 * quote that has not come back in half a minute is not slow, it is gone — and
 * the pay screen is sitting on a spinner with no price and no way out.
 */
const QUOTE_TIMEOUT_MS = 30_000

/** Source chains offered in the payment screen (mirrors the widget's set).
 * The same list `onboard.ts` declares to the wallet — one list, so a chain
 * cannot be offered here and be unknown there. */
const PAYMENT_CHAINS = WALLET_CHAINS

let initialized = false

/** The shared Relay client (public mainnet API — no key, as in the widget). */
function relayClient() {
  if (!initialized) {
    createClient({ baseApiUrl: MAINNET_RELAY_API, source: 'swarm-id' })
    initialized = true
  }
  return getClient()
}

/** Every chain offers its native token; stablecoins are listed where they are
 * the obvious alternative (matching the designs' Base/USDC example).
 *
 * Exported so the live contract suite derives its pairs from this table rather
 * than keeping a second copy: a token added to the picker is then contract-
 * tested against Relay by that alone. */
export const PAYMENT_TOKENS: Record<number, PaymentToken[]> = {
  [mainnet.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18 },
    {
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [base.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18 },
    {
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [arbitrum.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18 },
    {
      address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [optimism.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', name: 'Ether', decimals: 18 },
    {
      address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [polygon.id]: [
    { address: NATIVE_CURRENCY, symbol: 'POL', name: 'Polygon Ecosystem Token', decimals: 18 },
    {
      address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [gnosis.id]: [
    { address: NATIVE_CURRENCY, symbol: 'xDAI', name: 'xDAI', decimals: 18 },
    {
      address: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
}

/**
 * Quote a payment that delivers exactly `xdaiWei` to `recipient` on Gnosis.
 * EXACT_OUTPUT so the delivered amount is the one the operation needs — any
 * source-side price movement is absorbed by the amount the user pays.
 */
async function quotePayment(request: QuoteRequest): Promise<PaymentQuote> {
  const quote = await withTimeout(
    relayClient().actions.getQuote({
      chainId: request.chainId,
      currency: request.currency,
      toChainId: GNOSIS_CHAIN_ID,
      toCurrency: NATIVE_CURRENCY,
      tradeType: 'EXACT_OUTPUT',
      amount: request.xdaiWei.toString(),
      user: request.user,
      recipient: request.recipient,
    }),
    QUOTE_TIMEOUT_MS,
    'Relay did not answer with a price. Check your connection and try again.',
  )
  const currencyIn = quote.details?.currencyIn
  // Relay's own figures are raw, not display-ready: `amountFormatted` is the
  // full wei expansion and `amountUsd` carries six decimals. Rendered as-is
  // they sat above breakdown rows rounded to four digits.
  return {
    handle: quote,
    amountFormatted: displayAmount(currencyIn?.amountFormatted ?? ''),
    amountUsd: displayUsd(currencyIn?.amountUsd ?? ''),
    // A bridged rail delivers native xDAI and nothing else — carrying the
    // user's own token across would mean holding inventory in it. The gas
    // share arrives as xDAI too but is not swapped, so only the rest is.
    delivers: { input: 'xdai', amount: request.xdaiWei - request.gasXdaiWei },
  }
}

/** Wrap an EIP-1193 provider as the viem wallet client the SDK executes with. */
function walletClientFor(provider: EthereumProvider, chainId: number, address: string) {
  const chain =
    PAYMENT_CHAINS.find((candidate) => candidate.id === chainId) ??
    defineChain({
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [] } },
    })
  return createWalletClient({
    account: address as `0x${string}`,
    chain,
    transport: custom(provider as Parameters<typeof custom>[0]),
  })
}

/** Execute a quoted payment, reporting the SDK's current step description. */
async function executePayment(options: ExecutePaymentOptions): Promise<void> {
  await withTimeout(
    relayClient().actions.execute({
      quote: options.quote.handle as Execute,
      wallet: walletClientFor(options.provider, options.chainId, options.address),
      onProgress: ({ currentStep }) => {
        if (currentStep?.action) {
          options.onStatus?.(currentStep.action)
        }
      },
    }),
    EXECUTE_TIMEOUT_MS,
    'The payment is taking longer than Relay usually needs. It may still land — reopen the drive to check.',
  )
}

export const relayRail: PaymentRail = {
  chains: PAYMENT_CHAINS,
  tokens: (chainId) => PAYMENT_TOKENS[chainId] ?? [],
  quote: quotePayment,
  execute: executePayment,
}
