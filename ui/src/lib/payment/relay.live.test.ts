// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test against the REAL Relay API — `pnpm --filter @swarm-id/ui test:live`.
 *
 * Relay is the production rail and nothing else can exercise it: the dev rail
 * reproduces the shape, not the service. But the risk worth insuring against is
 * not "Relay is down" — it is *our request being wrong or our reading of the
 * response drifting from theirs*, which no local rail can catch and which would
 * surface as a broken pay screen in production only.
 *
 * So this quotes for real and asserts what we depend on. It is a **read**:
 * `getQuote` prices a route, it does not move money, needs no wallet and no
 * key. The addresses below are anvil's public dev accounts.
 *
 * Kept out of `pnpm test` because it needs the internet. Locally the contract
 * checks SKIP when the API cannot be reached — an outage is not our bug, and a
 * skip says "unchecked" where a pass would claim otherwise. In CI reachability
 * is itself asserted, so an outage there IS a red build: a green live job that
 * checked nothing is worse than a loud one. Either way, an API that answers
 * with a shape we do not handle fails.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { displayAmount, displayUsd } from './payment-rail'

const RELAY_QUOTE_URL = 'https://api.relay.link/quote'
const GNOSIS_CHAIN_ID = 100
const BASE_CHAIN_ID = 8453
const NATIVE = '0x0000000000000000000000000000000000000000'
/** Anvil's first dev account. Public, and only ever a quote parameter here. */
const ANY_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
/** 0.06 xDAI — the magnitude a real extend actually delivers. */
const XDAI_OUT_WEI = '60000000000000000'
const REQUEST_TIMEOUT_MS = 25_000

interface RelayQuote {
  steps?: { id?: string }[]
  details?: {
    currencyIn?: {
      amountFormatted?: string
      amountUsd?: string
      currency?: { symbol?: string; chainId?: number }
    }
    currencyOut?: { amountFormatted?: string; currency?: { chainId?: number } }
  }
}

/**
 * The same request `quotePayment` builds — EXACT_OUTPUT so the delivered amount
 * is the one the operation needs. Kept in the test rather than imported because
 * `relay.ts` goes through the SDK, and pinning the wire shape is the point.
 */
async function quote(): Promise<RelayQuote | undefined> {
  try {
    const response = await fetch(RELAY_QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        user: ANY_ADDRESS,
        recipient: ANY_ADDRESS,
        originChainId: BASE_CHAIN_ID,
        originCurrency: NATIVE,
        destinationChainId: GNOSIS_CHAIN_ID,
        destinationCurrency: NATIVE,
        tradeType: 'EXACT_OUTPUT',
        amount: XDAI_OUT_WEI,
      }),
    })
    return response.ok ? ((await response.json()) as RelayQuote) : undefined
  } catch {
    return undefined
  }
}

/**
 * Why a check did not run, when it did not run.
 *
 * Every check below is `quoted ?? ctx.skip(...)`, not `if (!quoted) return`.
 * A bare return passes: an offline run used to report six green contract
 * checks that had looked at nothing, which is the one report worse than a red
 * one. `ctx.skip` types as `never`, so it also narrows the quote for the
 * assertion that follows.
 */
const UNREACHABLE = 'Relay did not answer — this contract went unchecked.'

describe('Relay quote contract', () => {
  let quoted: RelayQuote | undefined

  beforeAll(async () => {
    quoted = await quote()
  })

  it.skipIf(!process.env.CI)('is reachable, or the rest of this suite is moot', () => {
    // Only enforced in CI. Locally an offline developer should see skips, not a
    // red suite; in CI an unreachable Relay is worth knowing about even though
    // the checks below skip themselves.
    expect(quoted, 'Relay did not answer — the contract below went unchecked').toBeDefined()
  })

  it('still routes Base ETH to native xDAI on Gnosis', (ctx) => {
    const answer = quoted ?? ctx.skip(UNREACHABLE)
    // The pair the rail is built on. If Relay stopped serving it, the payment
    // screens would offer a route that cannot be taken.
    expect(answer.details?.currencyOut?.currency?.chainId).toBe(GNOSIS_CHAIN_ID)
  })

  it('honours EXACT_OUTPUT, which is what makes the funding maths hold', (ctx) => {
    const answer = quoted ?? ctx.skip(UNREACHABLE)
    // `quoteFunding` sizes the swap input and gas to the wei; a rail that
    // delivered "about" that would under-fund the operation.
    expect(answer.details?.currencyOut?.amountFormatted).toBe('0.06')
  })

  it('exposes the currencyIn fields the pay screen reads', (ctx) => {
    const answer = quoted ?? ctx.skip(UNREACHABLE)
    const currencyIn = answer.details?.currencyIn
    expect(currencyIn?.amountFormatted, 'amountFormatted').toEqual(expect.any(String))
    expect(currencyIn?.amountUsd, 'amountUsd').toEqual(expect.any(String))
    expect(Number(currencyIn?.amountFormatted)).toBeGreaterThan(0)
    expect(Number(currencyIn?.amountUsd)).toBeGreaterThan(0)
  })

  it('hands back raw precision, which is why the rail formats it', (ctx) => {
    const answer = quoted ?? ctx.skip(UNREACHABLE)
    // Not a wish — a guard. `amountFormatted` is the full wei expansion
    // (eighteen decimals for a native token), and the pay screen puts it
    // directly above breakdown rows rounded to four significant digits. This
    // pins the reason `relay.ts` calls `displayAmount` rather than trusting it.
    const raw = answer.details?.currencyIn?.amountFormatted ?? ''
    expect(displayAmount(raw).length).toBeLessThanOrEqual(raw.length)
    // Cents at or above a cent, significant digits below one — either way not
    // the six decimals Relay sends. The second form is not hypothetical: a
    // small top-up really can cost a fraction of a cent, and pinning cents
    // alone would fail this suite on a cheap quote rather than on a defect.
    expect(displayUsd(answer.details?.currencyIn?.amountUsd ?? '')).toMatch(
      /^(\d+\.\d{2}|0\.0\d+)$/,
    )
  })

  it('returns a deposit step for the wallet to sign', (ctx) => {
    const answer = quoted ?? ctx.skip(UNREACHABLE)
    // `executePayment` hands the whole quote to the SDK, which walks the steps.
    // No steps means nothing for the user to sign and a payment that silently
    // never happens.
    expect(answer.steps?.length).toBeGreaterThan(0)
  })
})
