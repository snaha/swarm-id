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
 * Two layers. The wire shape is pinned on ONE canonical pair (Base ETH), in
 * enough depth to catch a field being renamed or its precision changing. Then
 * every pair the picker actually offers is quoted, so a chain or token added to
 * the table is contract-tested against Relay by that alone — the pairs are
 * derived from `PAYMENT_TOKENS`, not listed again here.
 *
 * Kept out of `pnpm test` because it needs the internet. It SKIPS when the API
 * cannot be reached — an outage is not our bug — and FAILS when the API answers
 * with a shape we do not handle, or refuses a route we offer, which is.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { WALLET_CHAINS, displayAmount, displayUsd } from './payment-rail'
import { PAYMENT_TOKENS } from './relay'

const RELAY_QUOTE_URL = 'https://api.relay.link/quote'
const GNOSIS_CHAIN_ID = 100
const BASE_CHAIN_ID = 8453
const NATIVE = '0x0000000000000000000000000000000000000000'
/**
 * Anvil's first two dev accounts, standing in for the payer's wallet and the
 * batch-owner address. Public, and only ever quote parameters here.
 *
 * Two of them, not one: in the app these are never the same address, and Relay
 * refuses a same-chain native quote that would be a self-send outright.
 */
const PAYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OWNER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
/** 0.06 xDAI — the magnitude a real extend actually delivers. */
const XDAI_OUT_WEI = '60000000000000000'
const REQUEST_TIMEOUT_MS = 25_000
/**
 * A refused route gets this many further attempts, spaced out. Route
 * availability is solver inventory, not a registry: Polygon POL has refused
 * with NO_SWAP_ROUTES_FOUND twice in one afternoon and quoted fine minutes
 * later both times. The retries make the job go red for a route that is GONE,
 * not for one mid-dip; a genuinely dropped pair still fails.
 */
const REFUSED_RETRIES = 2
const REFUSED_RETRY_DELAY_MS = 15_000
/**
 * What the retry pass may spend in total — every refused pair together, not one
 * budget each.
 *
 * Per pair it did not fit. Worst case one was `25s + 2 x (15s + 25s) = 105s`,
 * walked sequentially, so three refused pairs already outran the 300 s
 * `hookTimeout` in `vitest.live.config.ts` and six outran the job's own
 * ten-minute cap. That is the wrong way round: several pairs refusing AT ONCE
 * is a Relay short on inventory, which is precisely the state the retries were
 * added for, and the report it produced there was an unnamed hook timeout
 * rather than "this route is gone, and here it is".
 *
 * The two failure modes stay asymmetric on purpose — `unreachable`
 * short-circuits without retrying, so an outage is still fast.
 */
const REFUSED_RETRY_BUDGET_MS = 120_000
/**
 * The sweep as a whole, first pass and retries together, against the 300 s
 * `hookTimeout` that contains it. Retries only get what the first pass left, so
 * a slow first pass costs coverage of the second rather than the whole hook.
 */
const SWEEP_BUDGET_MS = 240_000

interface RelayQuote {
  steps?: { id?: string }[]
  details?: {
    currencyIn?: {
      amountFormatted?: string
      amountUsd?: string
      currency?: { symbol?: string; chainId?: number }
    }
    currencyOut?: {
      amountFormatted?: string
      minimumAmount?: string
      currency?: { chainId?: number }
    }
  }
}

/**
 * What one quote attempt came back as. A union rather than an optional quote,
 * because the two failures mean opposite things: unreachable is the internet
 * and skips, refused is a route we offer that Relay will not serve — the defect
 * this suite exists to find.
 */
type QuoteOutcome =
  | { status: 'quoted'; quote: RelayQuote }
  | { status: 'unreachable' }
  | { status: 'refused'; detail: string }

/** One (chain, token) the payment screen offers, as this suite quotes it. */
interface Pair {
  key: string
  label: string
  chainId: number
  currency: string
}

/**
 * Every pair the picker offers, read from the rail's own table. Gnosis is in
 * here too: the combined rail normally hands its native token to the direct
 * rail, but Relay is asked for it whenever the direct rail does not resolve.
 */
const PAIRS: Pair[] = WALLET_CHAINS.flatMap((chain) =>
  (PAYMENT_TOKENS[chain.id] ?? []).map((token) => ({
    key: `${chain.id}:${token.address}`,
    label: `${chain.name} ${token.symbol}`,
    chainId: chain.id,
    currency: token.address,
  })),
)

/**
 * The same request `quotePayment` builds — EXACT_OUTPUT so the delivered amount
 * is the one the operation needs. Kept in the test rather than imported because
 * `relay.ts` goes through the SDK, and pinning the wire shape is the point.
 */
async function quote(chainId: number, currency: string): Promise<QuoteOutcome> {
  let response: Response
  try {
    response = await fetch(RELAY_QUOTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        user: PAYER_ADDRESS,
        recipient: OWNER_ADDRESS,
        originChainId: chainId,
        originCurrency: currency,
        destinationChainId: GNOSIS_CHAIN_ID,
        destinationCurrency: NATIVE,
        tradeType: 'EXACT_OUTPUT',
        amount: XDAI_OUT_WEI,
      }),
    })
  } catch {
    return { status: 'unreachable' }
  }
  if (!response.ok) {
    return { status: 'refused', detail: `HTTP ${response.status} ${await response.text()}` }
  }
  return { status: 'quoted', quote: (await response.json()) as RelayQuote }
}

describe('Relay quote contract', () => {
  /** Keyed by `Pair.key`, filled once — one quote per pair, not per assertion. */
  const outcomes = new Map<string, QuoteOutcome>()
  let quoted: RelayQuote | undefined

  /**
   * Quote the refused pairs again, up to `REFUSED_RETRIES` rounds, until the
   * shared budget runs out. A round retries every pair still refused and pays
   * ONE delay for all of them: the spacing is what gives a solver time to
   * restock, and that wait is the same whether one pair is retried or twelve.
   *
   * @returns the pairs the budget ran out on — still refused, and given fewer
   *   attempts than the rest, which is not the same verdict and is worth saying.
   */
  async function retryRefused(deadline: number): Promise<Pair[]> {
    for (let round = 0; round < REFUSED_RETRIES; round += 1) {
      const pending = PAIRS.filter((pair) => outcomes.get(pair.key)?.status === 'refused')
      if (pending.length === 0) {
        return []
      }
      if (Date.now() + REFUSED_RETRY_DELAY_MS >= deadline) {
        return pending
      }
      await new Promise((resolve) => setTimeout(resolve, REFUSED_RETRY_DELAY_MS))
      for (const [index, pair] of pending.entries()) {
        if (Date.now() >= deadline) {
          return pending.slice(index)
        }
        outcomes.set(pair.key, await quote(pair.chainId, pair.currency))
      }
    }
    return []
  }

  beforeAll(async () => {
    const sweepDeadline = Date.now() + SWEEP_BUDGET_MS
    // ONE attempt per pair first, retrying nothing. The first pass therefore
    // always completes, so every refused route is named even when the budget
    // below never reaches it — which is the whole report this suite exists to
    // produce, and what a per-pair retry budget could swallow.
    //
    // Sequential on purpose: a dozen simultaneous POSTs to a public API with no
    // key is how a contract test turns into a rate-limited one.
    for (const pair of PAIRS) {
      outcomes.set(pair.key, await quote(pair.chainId, pair.currency))
    }
    const unretried = await retryRefused(
      Math.min(sweepDeadline, Date.now() + REFUSED_RETRY_BUDGET_MS),
    )
    if (unretried.length > 0) {
      // Not a silent cap: a pair that got one attempt and a pair that got all
      // of them fail below in the same words, and only this says which.
      console.warn(
        `Relay retry budget spent — ${unretried.length} refused pair(s) got fewer than ${REFUSED_RETRIES} retries: ${unretried.map((pair) => pair.label).join(', ')}`,
      )
    }
    const canonical = outcomes.get(`${BASE_CHAIN_ID}:${NATIVE}`)
    quoted = canonical?.status === 'quoted' ? canonical.quote : undefined
  })

  it.skipIf(!process.env.CI)('is reachable, or the rest of this suite is moot', () => {
    // Only enforced in CI. Locally an offline developer should see skips, not a
    // red suite; in CI an unreachable Relay is worth knowing about even though
    // the checks below skip themselves.
    expect(quoted, 'Relay did not answer — the contract below went unchecked').toBeDefined()
  })

  it('still routes Base ETH to native xDAI on Gnosis', () => {
    if (!quoted) {
      return
    }
    // The pair the rail is built on. If Relay stopped serving it, the payment
    // screens would offer a route that cannot be taken.
    expect(quoted.details?.currencyOut?.currency?.chainId).toBe(GNOSIS_CHAIN_ID)
  })

  it('honours EXACT_OUTPUT, which is what makes the funding maths hold', () => {
    if (!quoted) {
      return
    }
    // `quoteFunding` sizes the swap input and gas to the wei; a rail that
    // delivered "about" that would under-fund the operation.
    expect(quoted.details?.currencyOut?.amountFormatted).toBe('0.06')
  })

  it('exposes the currencyIn fields the pay screen reads', () => {
    if (!quoted) {
      return
    }
    const currencyIn = quoted.details?.currencyIn
    expect(currencyIn?.amountFormatted, 'amountFormatted').toEqual(expect.any(String))
    expect(currencyIn?.amountUsd, 'amountUsd').toEqual(expect.any(String))
    expect(Number(currencyIn?.amountFormatted)).toBeGreaterThan(0)
    expect(Number(currencyIn?.amountUsd)).toBeGreaterThan(0)
  })

  it('hands back raw precision, which is why the rail formats it', () => {
    if (!quoted) {
      return
    }
    // Not a wish — a guard. `amountFormatted` is the full wei expansion
    // (eighteen decimals for a native token), and the pay screen puts it
    // directly above breakdown rows rounded to four significant digits. This
    // pins the reason `relay.ts` calls `displayAmount` rather than trusting it.
    const raw = quoted.details?.currencyIn?.amountFormatted ?? ''
    expect(displayAmount(raw).length).toBeLessThanOrEqual(raw.length)
    // Cents at or above a cent, significant digits below one — either way not
    // the six decimals Relay sends. The second form is not hypothetical: a
    // small top-up really can cost a fraction of a cent, and pinning cents
    // alone would fail this suite on a cheap quote rather than on a defect.
    expect(displayUsd(quoted.details?.currencyIn?.amountUsd ?? '')).toMatch(
      /^(\d+\.\d{2}|0\.0\d+)$/,
    )
  })

  it('returns a deposit step for the wallet to sign', () => {
    if (!quoted) {
      return
    }
    // `executePayment` hands the whole quote to the SDK, which walks the steps.
    // No steps means nothing for the user to sign and a payment that silently
    // never happens.
    expect(quoted.steps?.length).toBeGreaterThan(0)
  })

  describe('every pair the picker offers still routes to Gnosis', () => {
    for (const pair of PAIRS) {
      it(pair.label, (context) => {
        const outcome = outcomes.get(pair.key)
        // Skipped, not passed: `unreachable` covers a route that hung past the
        // deadline as well as one that could not be dialled, and a green tick
        // on an unasserted pair reads as coverage this suite does not have.
        if (!outcome || outcome.status === 'unreachable') {
          context.skip()
          return
        }
        if (outcome.status === 'refused') {
          throw new Error(`Relay would not quote ${pair.label}: ${outcome.detail}`)
        }
        const details = outcome.quote.details
        expect(details?.currencyOut?.currency?.chainId, 'delivers on Gnosis').toBe(GNOSIS_CHAIN_ID)
        // The guaranteed floor, and the figure the funding maths is sized to.
        // Not `amountFormatted`: a same-chain swap can overshoot and deliver
        // more than was asked for, and only the minimum is promised.
        expect(details?.currencyOut?.minimumAmount, 'delivers the exact amount asked for').toBe(
          XDAI_OUT_WEI,
        )
        expect(
          Number(details?.currencyIn?.amountFormatted),
          'priced in the source token',
        ).toBeGreaterThan(0)
        expect(Number(details?.currencyIn?.amountUsd), 'priced in USD').toBeGreaterThan(0)
        // An ERC-20 source quotes two steps (approve, then deposit) and a
        // native one just the deposit — the count is Relay's business, having
        // something to sign is ours.
        expect(outcome.quote.steps?.length, 'something for the wallet to sign').toBeGreaterThan(0)
      })
    }
  })
})
