// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Turning a funding need into money at the batch-owner address.
 *
 * Quote how much xDAI buys the missing BZZ on SushiSwap, add the gas, have the
 * rail deliver that xDAI to the owner, then swap it to BZZ with the owner key.
 *
 * The swap leg is the same either way: the local chain carries a real BZZ
 * market at the mainnet addresses, so only the delivery differs (Relay in
 * production, the baked faucet playing solver locally — see `payment-rail.ts`).
 */
import { withTimeout } from '@snaha/swarm-id'

import { prefix0x } from '$lib/crypto/hex'
import type { FundingNeed } from '$lib/payment/drive-operation'
import { GAS_BUDGET_XDAI_WEI, postageChain } from '$lib/payment/postage-onchain'
import { derivePostageSigner } from '$lib/payment/purchase'

/** Swap slippage/rounding headroom on the quoted xDAI, as the widget uses.
 * The swap executes exact-INPUT, so the headroom is spent buying BZZ rather
 * than left over: the surplus lands as BZZ at the owner address, where the
 * next operation's funds check consumes it before asking for more. */
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

/**
 * The swap's own gas, which the delivery has to carry on top of everything
 * else.
 *
 * `swapDeliveredXdai` is signed by the owner key and pays for itself out of the
 * owner's balance — and it runs BEFORE the postage operations that
 * `GAS_BUDGET_XDAI_WEI` covers. Size the delivery without it and the swap
 * spends the operating budget back down, so the funds check that re-runs
 * immediately afterwards finds the owner short and rejects a payment that in
 * fact succeeded. Generous against a Gnosis swap's real cost (~0.0003 xDAI),
 * because the whole point is that this is never the binding constraint.
 */
export const SWAP_GAS_XDAI_WEI = 2_000_000_000_000_000n // 0.002 xDAI

/** What the user must pay for, in Gnosis-side terms. */
export interface FundingQuote {
  /**
   * Total xDAI (wei) the rail must deliver: swap input + gas, LESS whatever is
   * already sitting at the owner address. Zero means the operation is already
   * covered and the payment screens never open.
   */
  xdaiWei: bigint
  /** The xDAI portion that buys BZZ (the "value" line in the breakdown). */
  xdaiForBzzWei: bigint
  /** The xDAI portion kept for gas — the operation's budget shortfall plus the
   * swap's own gas, since the user pays for both (the breakdown's "gas" line). */
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
 * xDAI already at the owner address beyond the operating gas budget.
 *
 * Almost always the remains of an earlier attempt that delivered and then
 * failed to swap (or was interrupted between the two). It is the user's money,
 * sitting where the swap will spend it from, so it pays for this operation
 * before the rail does — otherwise they are charged twice for the same BZZ
 * while their first payment sits untouched.
 */
async function ownerSurplusXdai(
  destination: string,
  client: Awaited<ReturnType<typeof postageChain>>,
): Promise<bigint> {
  const balance = await client.getNativeBalance(prefix0x(destination) as `0x${string}`)
  return balance > GAS_BUDGET_XDAI_WEI ? balance - GAS_BUDGET_XDAI_WEI : 0n
}

/**
 * Size the xDAI that must arrive on Gnosis to satisfy `need`: an exact-output
 * Sushi quote for the missing BZZ (plus buffer), plus the missing gas, less
 * what the owner address already holds.
 * @throws when the swap route cannot be priced (no liquidity, RPC down) or
 *   when the trade would move the BZZ pool's price more than we accept.
 */
export async function quoteFunding(need: FundingNeed): Promise<FundingQuote> {
  const client = await postageChain()
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
  // Only when a swap will actually run — a gas-only shortfall is delivered and
  // spent directly, with nothing in between (and asking the rail to bridge an
  // allowance nobody spends would be the user's money).
  const xdaiForGasWei = xdaiForBzzWei > 0n ? need.xdai + SWAP_GAS_XDAI_WEI : need.xdai
  const required = xdaiForBzzWei + xdaiForGasWei
  // A gas-only need means the balance is BELOW the budget, so there is nothing
  // spare by definition — skip the read rather than pay for a certain zero.
  const surplus = xdaiForBzzWei > 0n ? await ownerSurplusXdai(need.destination, client) : 0n
  return {
    xdaiWei: required > surplus ? required - surplus : 0n,
    xdaiForBzzWei,
    xdaiForGasWei,
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
  const client = await postageChain()
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
