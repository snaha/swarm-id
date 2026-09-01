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
import { chainIdentity } from '$lib/payment/chain'
import { resolveLocalRail } from '$lib/payment/dev-funding'
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
 * of the same chain. The direct rail serves the Gnosis assets it has a route to
 * BZZ in and no others (`ACCEPTED` in `gnosis-direct.ts`: xDAI, WXDAI, USDC and
 * BZZ), so a chain-level claim on Gnosis silently took the rest with it —
 * Relay's Gnosis USDC.e among them — and stranded anyone holding one. Now each
 * rail wins exactly the tokens it offers, and the earlier one wins those both
 * do.
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
 * destination chain needs no bridge at all: the wallet sends the asset to the
 * batch owner and the swap takes it from there. It is cheaper and has fewer
 * moving parts than any bridged route, so it leads the list and takes every
 * Gnosis asset it can carry — xDAI, WXDAI, USDC and BZZ — away from whatever
 * else would have claimed them. Only those: anything else Gnosis offers has no
 * route to BZZ from here, so it stays with the bridged rail.
 *
 * Then, for the other chains:
 *
 * - **Gnosis mainnet gets Relay**, judged by genesis hash, since a dev chain
 *   reports mainnet's chain id on purpose. That is the whole of the rule in a
 *   production build: Relay delivers to the real Gnosis and to nowhere else, so
 *   an endpoint that is not the real Gnosis would be handed a rail whose money
 *   lands on a chain this app never reads — a shortfall it can never see clear,
 *   after the user has paid. The endpoint is user-editable in network settings,
 *   so this is reachable from a shipped build and not only from a dev one.
 * - **A production build never fakes a payment.** What keeps the dev rail out
 *   of the shipped bundle is not this check — a dead branch does not remove a
 *   static import — but the build-time swap behind `$lib/payment/dev-funding`,
 *   which leaves `resolveLocalRail` returning nothing there.
 * - **On a PROVEN dev chain, a bridged rail exists only if the local source
 *   chain is up.** Without one there is still the direct path, which needs
 *   nothing but the chain the app is already talking to.
 * - **An endpoint we could not identify gets no bridged rail at all.** "Not
 *   proven mainnet" is not the same answer as "proven dev": a blipped probe
 *   against a real Gnosis endpoint used to be handed the local rail, which
 *   takes a deposit on a chain the destination has never heard of and then
 *   waits out its two-minute delivery timeout blaming a solver that was never
 *   involved. Nothing offered is the honest answer.
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
  const identity = await chainIdentity().catch(() => undefined)
  // Relay's delivery leg is hardcoded to the real Gnosis (`toChainId` in
  // `relay.ts`) and nothing about a quote can redirect it, so it is offered
  // only where the app is watching that same chain — in a shipped build as much
  // as in a dev one. Pointed at a fork or a testnet, it would take a real
  // payment on the source chain and deliver where this app never looks.
  if (identity?.kind === 'mainnet') {
    return relayRail
  }
  if (!import.meta.env.DEV) {
    return undefined
  }
  // Proven, not merely "not mainnet" — the same rule `chain.ts` states for the
  // dev answer, and the same one `resolveGnosisDirectRail` applies: an
  // unidentified or non-Gnosis endpoint gets no local rail to sign into.
  return identity?.kind === 'dev' ? resolveLocalRail() : undefined
}
