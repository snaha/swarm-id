// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The payment rail seam: what carries the user's money from whatever chain
 * they hold funds on to native xDAI at the batch-owner address on Gnosis.
 *
 * Production has exactly one — Relay Protocol (`relay.ts`). Locally there can
 * be no real one: Relay is an intent/solver network, so its quote comes from a
 * hosted API and the delivery is an off-chain solver paying out of its own
 * inventory on real Gnosis. A local chain is invisible to all of it. The dev
 * rail (`$lib/dev/local-payment-rail`) stands in by taking a genuine signature
 * on a local source chain and having the baked faucet play the solver.
 *
 * Everything downstream of a rail is untouched production code: the delivered
 * xDAI is swapped to BZZ by `swapDeliveredXdai` and spent by the postage
 * engine, on both rails alike.
 *
 * This module is deliberately a LEAF — it defines the contract and imports no
 * rail. Picking one lives in `resolve-rail.ts`, which may import them all; a
 * rail importing a value from here while this imported it back would be a
 * genuine initialisation cycle, and the type checker cannot see one.
 */
import type { Chain } from 'viem'

/** Native-token sentinel for "the chain's own currency". */
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000'

/** A token the user can pay with on a given source chain. */
export interface PaymentToken {
  address: string
  symbol: string
  /** Full name, shown alongside the symbol as in the designs ("ETH (Ether)"). */
  name: string
  decimals: number
}

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
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

export interface PaymentQuote {
  /**
   * Rail-private payload, consumed only by the rail that produced it — Relay
   * keeps its SDK `Execute` here, the dev rail its own record. Opaque so a
   * second rail can exist at all.
   */
  handle: unknown
  /** Source-token amount the user pays, formatted (e.g. "0.00000872"). */
  amountFormatted: string
  /** USD value of the payment, formatted (e.g. "0.17"). */
  amountUsd: string
}

export interface ExecutePaymentOptions {
  quote: PaymentQuote
  provider: EthereumProvider
  chainId: number
  /** The payer's address (their connected wallet). */
  address: string
  /**
   * Receives the rail's current step so the pending screen can name what is
   * happening (e.g. the design's "Cross-swap xDAI on Relay").
   */
  onStatus?: (status: string) => void
}

export interface PaymentRail {
  /** Source chains this rail offers, in the order the picker shows them. */
  chains: Chain[]
  /** What the user may pay with on `chainId` — empty for a chain it does not serve. */
  tokens(chainId: number): PaymentToken[]
  /** Price a payment that delivers exactly `xdaiWei` to `recipient` on Gnosis. */
  quote(request: QuoteRequest): Promise<PaymentQuote>
  /** Take the payment and see it through to delivery. */
  execute(options: ExecutePaymentOptions): Promise<void>
}

/**
 * Ask the wallet to switch to `chainId`, adding the chain when the wallet does
 * not know it. Rejects if the user declines — the caller shows the design's
 * "unconfirmed chain change" state while this is pending.
 */
export async function switchWalletChain(
  provider: EthereumProvider,
  chainId: number,
  chains: Chain[],
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
    const chain = chains.find((candidate) => candidate.id === chainId)
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
