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
import { resolveLocalRail } from '$lib/payment/dev-funding'
import { resolveGnosisDirectRail } from '$lib/payment/gnosis-direct'
import type { PaymentRail, PaymentToken } from '$lib/payment/payment-rail'
import { chainIdentity } from '$lib/payment/postage-onchain'
import { relayRail } from '$lib/payment/relay'

/**
 * Present several rails as one, dispatching on the chain AND token the user
 * picked.
 *
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
 * Then, for the other chains:
 *
 * - **A production build always pays for real.** Whatever chain it is pointed
 *   at, a shipped bundle that faked a payment when an RPC blipped would be far
 *   worse than one that fails. What keeps the dev rail out of the shipped
 *   bundle is not this check — a dead branch does not remove a static import —
 *   but the build-time swap behind `$lib/payment/dev-funding`.
 * - **Gnosis mainnet always pays for real**, judged by genesis hash, since a
 *   dev chain reports mainnet's chain id on purpose.
 * - **Off mainnet, a bridged rail exists only if the local source chain is up.**
 *   Without one there is still the direct path, which needs nothing but the
 *   chain the app is already talking to.
 *
 * @returns the rail to pay through, or undefined when there is none — which is
 *   an error at the funding seam, not a licence to conjure the money.
 */
export async function resolvePaymentRail(): Promise<PaymentRail | undefined> {
  const direct = await resolveGnosisDirectRail()
  const bridged = await resolveBridgedRail()
  const rails = [direct, bridged].filter((rail) => rail !== undefined)
  return rails.length > 0 ? combineRails(rails) : undefined
}

/** The rail for chains other than the destination itself. */
async function resolveBridgedRail(): Promise<PaymentRail | undefined> {
  if (!import.meta.env.DEV) {
    return relayRail
  }
  const identity = await chainIdentity().catch(() => undefined)
  if (identity?.isMainnet) {
    return relayRail
  }
  return resolveLocalRail()
}
