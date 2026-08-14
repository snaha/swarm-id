// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Paying from Gnosis, where there is nothing to bridge.
 *
 * Every other source chain needs a rail to carry money to the batch-owner
 * address. Gnosis does not: the destination IS the source, so the wallet simply
 * sends xDAI to the owner and the operation continues from there — the same
 * SushiSwap swap and the same postage engine as any other route.
 *
 * That makes it the cheapest path by a wide margin (no bridge fee, no solver
 * spread) and the most reliable (no third party between signing and delivery),
 * so it is offered ahead of the bridged chains rather than as a fallback.
 * Routing it through a cross-chain network instead would pay that network to
 * move money across zero chains.
 *
 * It is also the one rail that is genuinely the same code locally: the local
 * chain answers as Gnosis, so a wallet pointed at it makes a real payment with
 * nothing standing in — no solver, no second chain, no invented prices.
 */
import { withTimeout } from '@snaha/swarm-id'
import { type Chain, defineChain, formatUnits } from 'viem'

import { chainIdentity, postageChain } from '$lib/payment/chain'
import {
  type ExecutePaymentOptions,
  NATIVE_CURRENCY,
  type PaymentQuote,
  type PaymentRail,
  type PaymentToken,
  type QuoteRequest,
  displayAmount,
  displayUsd,
} from '$lib/payment/payment-rail'
import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

export const GNOSIS_CHAIN_ID = 100
const XDAI_DECIMALS = 18

/** Confirming a transfer on a 5s-block chain; generous, but finite. */
const TRANSFER_TIMEOUT_MS = 120_000

const XDAI: PaymentToken = {
  address: NATIVE_CURRENCY,
  symbol: 'xDAI',
  name: 'xDAI',
  decimals: XDAI_DECIMALS,
}

/**
 * The chain descriptor the wallet is asked to switch to.
 *
 * Built from the endpoint the app is actually pointed at, not from viem's
 * static `gnosis`, because off mainnet that endpoint is the local chain — which
 * answers as 100 on purpose. Naming it says which one a wallet is being sent
 * to, since the chain id cannot.
 */
function gnosisChain(isMainnet: boolean): Chain {
  return defineChain({
    id: GNOSIS_CHAIN_ID,
    name: isMainnet ? 'Gnosis Chain' : 'Gnosis Chain (fake)',
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: XDAI_DECIMALS },
    rpcUrls: { default: { http: [networkSettingsStore.gnosisRpcUrl] } },
  })
}

/** What `quote` hands `execute` — this rail's private payload. */
interface DirectHandle {
  recipient: `0x${string}`
  xdaiWei: bigint
}

function isDirectHandle(handle: unknown): handle is DirectHandle {
  const candidate = handle as DirectHandle | undefined
  return typeof candidate?.recipient === 'string' && typeof candidate.xdaiWei === 'bigint'
}

/**
 * Price a direct payment: the user pays exactly what must arrive, because
 * nothing takes a cut in between. Gas is the wallet's own business and it
 * prices that itself.
 *
 * Pure and synchronous — there is no route to shop for.
 */
export function quoteDirectPayment(request: QuoteRequest): PaymentQuote {
  const amount = formatUnits(request.xdaiWei, XDAI_DECIMALS)
  return {
    handle: { recipient: request.recipient as `0x${string}`, xdaiWei: request.xdaiWei },
    amountFormatted: displayAmount(amount),
    // xDAI is a dollar stablecoin, so the USD figure is the amount itself.
    amountUsd: displayUsd(amount),
  }
}

/** Send the xDAI, and wait for it to confirm. */
async function executeDirectPayment(options: ExecutePaymentOptions): Promise<void> {
  const handle = options.quote.handle
  if (!isDirectHandle(handle)) {
    throw new Error('This payment was quoted by a different rail.')
  }

  const transactionHash = (await options.provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: options.address,
        to: handle.recipient,
        value: `0x${handle.xdaiWei.toString(16)}`,
      },
    ],
  })) as string

  // Only now: the dialog swaps its "approve the payment in your wallet" screen
  // for the progress card on the first status, so an earlier one would talk
  // over the wallet's own prompt.
  options.onStatus?.('Confirming your payment')
  const chain = await postageChain()
  await withTimeout(
    chain.waitForTransactionSuccess(transactionHash as `0x${string}`),
    TRANSFER_TIMEOUT_MS,
    'The payment was sent but not confirmed in time. It may still land — reopen the drive to check.',
  )
}

/**
 * The Gnosis rail for the endpoint currently configured, or undefined when that
 * endpoint cannot be identified — with no answer about which chain it is, we
 * cannot honestly name it to a wallet.
 */
export async function resolveGnosisDirectRail(): Promise<PaymentRail | undefined> {
  const identity = await chainIdentity().catch(() => undefined)
  if (identity === undefined || identity.kind === 'unsupported') {
    return undefined
  }
  const chain = gnosisChain(identity.kind === 'mainnet')
  return {
    chains: [chain],
    tokens: (chainId) => (chainId === GNOSIS_CHAIN_ID ? [XDAI] : []),
    quote: (request) => Promise.resolve(quoteDirectPayment(request)),
    execute: executeDirectPayment,
  }
}
