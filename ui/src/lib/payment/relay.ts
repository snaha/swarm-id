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
 */
import { type Execute, MAINNET_RELAY_API, createClient, getClient } from '@relayprotocol/relay-sdk'
import { type Chain, createWalletClient, custom, defineChain } from 'viem'
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from 'viem/chains'

/** Native-token sentinel Relay uses for "the chain's own currency". */
const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'

const GNOSIS_CHAIN_ID = 100

/** Source chains offered in the payment screen (mirrors the widget's set). */
export const PAYMENT_CHAINS: Chain[] = [mainnet, base, arbitrum, optimism, polygon, gnosis]

let initialized = false

/** The shared Relay client (public mainnet API — no key, as in the widget). */
export function relayClient() {
  if (!initialized) {
    createClient({ baseApiUrl: MAINNET_RELAY_API, source: 'swarm-id' })
    initialized = true
  }
  return getClient()
}

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

/** A token the user can pay with on a given source chain. */
export interface PaymentToken {
  address: string
  symbol: string
  decimals: number
}

/** Every chain offers its native token; stablecoins are listed where they are
 * the obvious alternative (matching the designs' Base/USDC example). */
export const PAYMENT_TOKENS: Record<number, PaymentToken[]> = {
  [mainnet.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', decimals: 18 },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
  ],
  [base.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', decimals: 18 },
    { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
  ],
  [arbitrum.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', decimals: 18 },
    { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6 },
  ],
  [optimism.id]: [
    { address: NATIVE_CURRENCY, symbol: 'ETH', decimals: 18 },
    { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', symbol: 'USDC', decimals: 6 },
  ],
  [polygon.id]: [
    { address: NATIVE_CURRENCY, symbol: 'POL', decimals: 18 },
    { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', decimals: 6 },
  ],
  [gnosis.id]: [
    { address: NATIVE_CURRENCY, symbol: 'xDAI', decimals: 18 },
    { address: '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0', symbol: 'USDC', decimals: 6 },
  ],
}

export interface PaymentQuote {
  /** The SDK quote object, passed back to {@link executePayment}. */
  quote: Execute
  /** Source-token amount the user pays, formatted (e.g. "0.00000872"). */
  amountFormatted: string
  /** USD value of the payment, formatted (e.g. "0.17"). */
  amountUsd: string
}

export interface QuoteRequest {
  chainId: number
  currency: string
  /** The payer's address (their connected wallet). */
  user: string
  /** The batch-owner address the xDAI must land on. */
  recipient: string
  /** Exact xDAI (wei) that must arrive on Gnosis. */
  xdaiWei: bigint
}

/**
 * Quote a payment that delivers exactly `xdaiWei` to `recipient` on Gnosis.
 * EXACT_OUTPUT so the delivered amount is the one the operation needs — any
 * source-side price movement is absorbed by the amount the user pays.
 */
export async function quotePayment(request: QuoteRequest): Promise<PaymentQuote> {
  const quote = await relayClient().actions.getQuote({
    chainId: request.chainId,
    currency: request.currency,
    toChainId: GNOSIS_CHAIN_ID,
    toCurrency: NATIVE_CURRENCY,
    tradeType: 'EXACT_OUTPUT',
    amount: request.xdaiWei.toString(),
    user: request.user,
    recipient: request.recipient,
  })
  const currencyIn = quote.details?.currencyIn
  return {
    quote,
    amountFormatted: currencyIn?.amountFormatted ?? '',
    amountUsd: currencyIn?.amountUsd ?? '',
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

/**
 * Execute a quoted payment. `onStatus` receives the SDK's current step
 * description so the pending screen can name what is happening (e.g. the
 * design's "Cross-swap xDAI on Relay").
 */
export async function executePayment(
  quote: PaymentQuote,
  provider: EthereumProvider,
  chainId: number,
  address: string,
  onStatus?: (status: string) => void,
): Promise<void> {
  await relayClient().actions.execute({
    quote: quote.quote,
    wallet: walletClientFor(provider, chainId, address),
    onProgress: ({ currentStep }) => {
      if (currentStep?.action) {
        onStatus?.(currentStep.action)
      }
    },
  })
}

/**
 * Ask the wallet to switch to `chainId`, adding the chain when the wallet does
 * not know it. Rejects if the user declines — the caller shows the design's
 * "unconfirmed chain change" state while this is pending.
 */
export async function switchWalletChain(
  provider: EthereumProvider,
  chainId: number,
): Promise<void> {
  const hexChainId = `0x${chainId.toString(16)}`
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    })
  } catch (error) {
    const code = (error as { code?: number }).code
    // 4902: the wallet has no such chain configured — offer to add it.
    const CHAIN_NOT_ADDED = 4902
    if (code !== CHAIN_NOT_ADDED) {
      throw error
    }
    const chain = PAYMENT_CHAINS.find((candidate) => candidate.id === chainId)
    if (!chain) {
      throw error
    }
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexChainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
        },
      ],
    })
  }
}
