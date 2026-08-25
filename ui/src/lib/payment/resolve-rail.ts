// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Picking the rails a payment can be carried by.
 *
 * Separate from `payment-rail.ts` on purpose: the contract module is a leaf, so
 * that the rails can import values from it (the native-currency sentinel) with
 * no risk of an initialisation cycle. This module is where knowing about every
 * rail is allowed.
 */
import { resolveGnosisDirectRail } from '$lib/payment/gnosis-direct'
import type { PaymentRail, PaymentToken } from '$lib/payment/payment-rail'
import { relayRail } from '$lib/payment/relay'

/**
 * Present several rails as one, dispatching on the chain AND token the user
 * picked.
 *
 * **Paying from Gnosis needs no bridge at all**: the destination IS the source,
 * so the wallet sends xDAI to the batch owner and the swap takes it from there.
 * The dialog stays rail-agnostic this way: it renders a chain list and asks for
 * a quote, without knowing that native xDAI on Gnosis is answered by a direct
 * transfer and everything else by a bridge.
 *
 * Dispatch is per TOKEN, not per chain, because two rails can each serve part
 * of the same chain. The direct rail moves native xDAI only — it is a plain
 * transfer — so a chain-level claim on Gnosis silently removed Gnosis USDC from
 * the picker, stranding anyone holding it there. Now the direct rail takes the
 * native token, Relay keeps the rest, and the earlier rail wins only the tokens
 * it actually offers.
 *
 * Exported for its test: the composition rule is the subtle part of this
 * module, and `resolvePaymentRail` cannot be asked about it without a chain.
 */
export function combineRails(rails: PaymentRail[]): PaymentRail {
  const seen = new Set<number>()
  const chains = rails
    .flatMap((rail) => rail.chains)
    .filter((chain) => !seen.has(chain.id) && seen.add(chain.id))

  /** Every token any rail serves on `chainId`, the earliest rail's copy winning. */
  function tokens(chainId: number): PaymentToken[] {
    const byAddress = new Map<string, PaymentToken>()
    for (const rail of rails) {
      for (const token of rail.tokens(chainId)) {
        if (!byAddress.has(token.address)) {
          byAddress.set(token.address, token)
        }
      }
    }
    return [...byAddress.values()]
  }

  function railFor(chainId: number, currency: string): PaymentRail {
    const rail = rails.find((candidate) =>
      candidate.tokens(chainId).some((token) => token.address === currency),
    )
    if (!rail) {
      throw new Error(`No payment route available for that token on chain ${chainId}.`)
    }
    return rail
  }

  return {
    chains,
    tokens,
    quote: (request) => railFor(request.chainId, request.currency).quote(request),
    execute: (options) => railFor(options.chainId, options.currency).execute(options),
  }
}

/**
 * Which rails — if any — this payment can be carried by.
 *
 * **Gnosis first, always, when the endpoint is Gnosis.** Paying from the
 * destination chain needs no bridge at all: the wallet sends xDAI to the batch
 * owner and the swap takes it from there. It is cheaper and has fewer moving
 * parts than any bridged route, so it leads the list and takes Gnosis xDAI away
 * from whatever else would have claimed it. Only xDAI: it is a plain transfer,
 * so Gnosis's other tokens stay with the bridged rail.
 *
 * Relay carries everything else, on every chain it serves — including the
 * tokens on Gnosis that a plain transfer cannot move.
 *
 * @returns the rail to pay through, or undefined when there is none — which is
 *   an error at the funding seam, not a licence to conjure the money.
 */
export async function resolvePaymentRail(): Promise<PaymentRail | undefined> {
  const direct = await resolveGnosisDirectRail()
  const rails = [direct, relayRail].filter((rail) => rail !== undefined)
  return rails.length > 0 ? combineRails(rails) : undefined
}
