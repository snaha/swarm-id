// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Turning a funding need into money at the batch-owner address.
 *
 * Production: quote how much xDAI buys the missing BZZ on SushiSwap, add the
 * gas budget, have Relay deliver that xDAI to the owner, then swap it to BZZ
 * with the owner key. Local dev: the queen faucet stands in for both legs (no
 * Relay, no DEX on the anvil chain).
 */
import { withTimeout } from '@snaha/swarm-id'

import { prefix0x } from '$lib/crypto/hex'
import type { FundingNeed } from '$lib/payment/drive-operation'
import { postageChainClient } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'

/** Swap slippage/rounding headroom on the quoted xDAI, as the widget uses.
 * Leftover xDAI stays at the owner address as future gas — never stranded. */
const SWAP_BUFFER_NUMERATOR = 12n
const SWAP_BUFFER_DENOMINATOR = 10n

/** Price impact above which we refuse to quote — BZZ pools on Gnosis are thin
 * (~$10k total), and a large resize can move the price hard. */
const MAX_PRICE_IMPACT_PERCENT = 5n
const PERCENT = 100n

/** Reference trade sizing the near-spot price: small enough that its own
 * impact is negligible, large enough not to be lost to rounding. */
const IMPACT_REFERENCE_BZZ_PLUR = 1_000_000_000_000n // 0.0001 BZZ

const SWAP_TIMEOUT_MS = 120_000

/** What the user must pay for, in Gnosis-side terms. */
export interface FundingQuote {
  /** Total xDAI (wei) Relay must deliver: swap input + gas budget. */
  xdaiWei: bigint
  /** The xDAI portion that buys BZZ (the "value" line in the breakdown). */
  xdaiForBzzWei: bigint
  /** The xDAI portion kept for gas (the "gas" line in the breakdown). */
  xdaiForGasWei: bigint
  /** BZZ (PLUR) the swap must deliver. */
  bzzPlur: bigint
}

/**
 * How much worse than the near-spot rate this trade fills, in percent —
 * the pool's price impact for a trade this size. Compared against a small
 * reference trade rather than a spot oracle, which the pool does not expose.
 */
function priceImpactPercent(
  referenceIn: bigint,
  referenceOut: bigint,
  actualIn: bigint,
  actualOut: bigint,
): bigint {
  // Cross-multiplied rates avoid dividing bigints down to zero.
  const referenceRate = referenceIn * actualOut
  const actualRate = actualIn * referenceOut
  if (actualRate <= referenceRate) {
    return 0n
  }
  return ((actualRate - referenceRate) * PERCENT) / referenceRate
}

/**
 * Size the xDAI that must arrive on Gnosis to satisfy `need`: an exact-output
 * Sushi quote for the missing BZZ (plus buffer), plus the missing gas.
 * @throws when the swap route cannot be priced (no liquidity, RPC down) or
 *   when the trade would move the BZZ pool's price more than we accept.
 */
export async function quoteFunding(need: FundingNeed): Promise<FundingQuote> {
  const client = postageChainClient()
  let xdaiForBzzWei = 0n
  if (need.bzz > 0n) {
    const [quoted, reference] = await Promise.all([
      client.quoteXdaiInForBzzOut(need.bzz),
      client.quoteXdaiInForBzzOut(IMPACT_REFERENCE_BZZ_PLUR),
    ])
    const impact = priceImpactPercent(reference, IMPACT_REFERENCE_BZZ_PLUR, quoted, need.bzz)
    if (impact > MAX_PRICE_IMPACT_PERCENT) {
      throw new Error(
        `This amount would move the BZZ price by about ${impact}%. Try a smaller change.`,
      )
    }
    xdaiForBzzWei = (quoted * SWAP_BUFFER_NUMERATOR) / SWAP_BUFFER_DENOMINATOR
  }
  return {
    xdaiWei: xdaiForBzzWei + need.xdai,
    xdaiForBzzWei,
    xdaiForGasWei: need.xdai,
    bzzPlur: need.bzz,
  }
}

/**
 * Turn xDAI that has landed at the owner address into the BZZ the operation
 * needs. Signed by the owner key; skipped when no BZZ is required (a
 * gas-only shortfall).
 */
export async function swapDeliveredXdai(derivationKey: string, quote: FundingQuote): Promise<void> {
  if (quote.bzzPlur === 0n || quote.xdaiForBzzWei === 0n) {
    return
  }
  const client = postageChainClient()
  const { signerKey, destination } = await derivePostageSigner(derivationKey)
  const hash = await client.swapXdaiToBzz({
    originPrivateKey: prefix0x(signerKey.toHex()) as `0x${string}`,
    amountXdai: quote.xdaiForBzzWei,
    recipient: prefix0x(destination) as `0x${string}`,
  })
  await withTimeout(
    client.waitForTransactionSuccess(hash),
    SWAP_TIMEOUT_MS,
    'The BZZ swap was not confirmed in time.',
  )
}
