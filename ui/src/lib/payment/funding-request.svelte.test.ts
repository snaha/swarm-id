// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The settlement half of the funding seam: which quote the swap ends up
 * spending, and what a cancel does to a request the user cannot call back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FundingQuote } from '$lib/payment/funding'
import type { PaymentRail } from '$lib/payment/payment-rail'
import type { Account } from '$lib/types'

import {
  type FundingRequester,
  PaymentCancelledError,
  UseWidgetError,
  createFundingRequester,
} from './funding-request.svelte'

const XDAI = 10n ** 18n

const swapDelivered = vi.fn<(key: string, quote: FundingQuote) => Promise<void>>(() =>
  Promise.resolve(),
)
const resolvePaymentRail = vi.fn()

vi.mock('$lib/payment/funding', () => ({
  swapDelivered: (key: string, quote: FundingQuote) => swapDelivered(key, quote),
}))
vi.mock('$lib/payment/resolve-rail', () => ({
  resolvePaymentRail: () => resolvePaymentRail(),
}))

const rail: PaymentRail = {
  chains: [],
  tokens: () => [],
  quote: () => Promise.reject(new Error('the screens do the quoting')),
  execute: () => Promise.reject(new Error('the screens do the paying')),
}

const need = { destination: '0xowner', bzz: 5n, xdai: 0n }
const account = () => ({ derivationKey: 'aa' }) as unknown as Account

/** A quote asking for `xdaiWei` on top of a fixed swap input. */
function quote(xdaiWei: bigint): FundingQuote {
  return {
    xdaiWei,
    xdaiForBzzWei: 6n * XDAI,
    xdaiForGasWei: XDAI / 100n,
    bzzPlur: 5n,
    priceImpactPercent: 0,
    paidWith: 'xdai',
    paidAmount: 6n * XDAI,
  }
}

describe('createFundingRequester', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolvePaymentRail.mockResolvedValue(rail)
  })

  it('surfaces the need and its rail as one pending payment, unpriced', async () => {
    // No quote here: the screens open on the method chooser, whose default
    // method needs none, and the built-in path prices itself when chosen.
    const requester = createFundingRequester(account)
    void requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())
    expect(requester.pending?.need).toBe(need)
    expect(requester.pending?.rail).toBe(rail)
  })

  it('swaps the quote the payment settled against, not the one it opened with', async () => {
    // A failed attempt is re-priced before the user pays again, and the second
    // delivery is sized by that second quote — spending the first one's figure
    // would swap money that was never delivered.
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    const repriced = { ...quote(XDAI / 2n), xdaiForBzzWei: 5n * XDAI }
    requester.resolve(repriced)
    await running
    expect(swapDelivered).toHaveBeenCalledWith('aa', repriced)
    expect(requester.pending).toBeUndefined()
  })

  it('fails the request as cancelled when the user backs out', async () => {
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    requester.cancel()
    await expect(running).rejects.toBeInstanceOf(PaymentCancelledError)
    expect(swapDelivered).not.toHaveBeenCalled()
  })

  it('keeps a request alive when the cancel came with a payment in flight', async () => {
    // The wallet is holding a signature that cannot be withdrawn. Rejecting
    // here would drop the settlement on the floor: the user approves, the money
    // leaves, and nothing is swapped or recorded.
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    const settled = quote(XDAI)
    requester.cancel({ reason: 'payment-in-flight' })
    expect(requester.pending).toBeUndefined()
    requester.resolve(settled)
    await running
    expect(swapDelivered).toHaveBeenCalledWith('aa', settled)
  })

  /**
   * A plain cancel cannot stop a payment already with the wallet either — and
   * the closed drive dialog and the unmounted component that send one are no
   * more able to call it back than the Cancel button is. Disarming the
   * settlement here would drop the approval that follows.
   */
  it('leaves an in-flight settlement armed through a later plain cancel', async () => {
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    const settled = quote(XDAI)
    requester.cancel({ reason: 'payment-in-flight' })
    requester.cancel()
    requester.resolve(settled)
    await running
    expect(swapDelivered).toHaveBeenCalledWith('aa', settled)
  })

  /**
   * What the add-drive dialog hides its Cancel on. Dismissing the payment
   * screens with a signature already at the wallet drops the user back on the
   * pending screen; a Cancel there supersedes the attempt, the payment lands
   * anyway, and the operation dies at `beforeSpend` with the money swapped and
   * no drive to show for it.
   */
  it('stays armed once a payment has been raised, through a dismissal and its settlement', async () => {
    const requester = createFundingRequester(account)
    expect(requester.armed).toBe(false)

    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())
    expect(requester.armed).toBe(true)

    requester.cancel({ reason: 'payment-in-flight' })
    requester.cancel()
    expect(requester.armed).toBe(true)

    // And past the settlement: the money is spent, so cancelling the rest of
    // the operation is no cheaper than it was a moment ago.
    requester.resolve(quote(XDAI))
    await running
    expect(requester.armed).toBe(true)
  })

  it('disarms when the request is let go, whichever way', async () => {
    for (const letGo of [
      (requester: FundingRequester) => requester.cancel(),
      (requester: FundingRequester) => requester.cancel({ reason: 'wallet-rejected' }),
      (requester: FundingRequester) => requester.cancel({ reason: 'use-widget' }),
      (requester: FundingRequester) =>
        requester.cancel({ reason: 'payment-unconfirmed', error: new Error('unconfirmed') }),
    ]) {
      const requester = createFundingRequester(account)
      const running = requester.request(need)
      await vi.waitFor(() => expect(requester.pending).toBeDefined())

      letGo(requester)
      await expect(running).rejects.toBeInstanceOf(Error)
      expect(requester.armed).toBe(false)
    }
  })

  it('ends the operation when the in-flight payment came back a wallet rejection', async () => {
    // Nothing was sent, so nothing will ever settle this — and the drive dialog
    // returns to its form rather than reporting a failure the user chose.
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    requester.cancel({ reason: 'payment-in-flight' })
    requester.cancel({ reason: 'wallet-rejected' })
    await expect(running).rejects.toBeInstanceOf(PaymentCancelledError)
    expect(swapDelivered).not.toHaveBeenCalled()
  })

  /**
   * A broadcast transfer whose confirmation timed out is not a cancel: the
   * money may be landing. Failing with the rail's own words is what puts the
   * drive dialog on its error screen, whose retry re-prices — and a re-price
   * absorbs whatever arrived instead of charging for it twice.
   */
  it('fails the request with the rail’s words when the payment went unconfirmed', async () => {
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    const unconfirmed = new Error('The payment was sent but not confirmed in time.')
    requester.cancel({ reason: 'payment-in-flight' })
    requester.cancel({ reason: 'payment-unconfirmed', error: unconfirmed })
    await expect(running).rejects.toBe(unconfirmed)
    expect(swapDelivered).not.toHaveBeenCalled()
  })

  /**
   * Choosing fund.bzz.limo abandons the engine operation — nothing is signed
   * at the method screen — but it is not a cancel: the add-drive dialog is
   * expected to open the widget on the back of it, and reading it as a cancel
   * would drop the user on a form with no popup and no explanation.
   */
  it('fails the request with its own type when the widget is chosen', async () => {
    const requester = createFundingRequester(account)
    const running = requester.request(need)
    await vi.waitFor(() => expect(requester.pending).toBeDefined())

    requester.cancel({ reason: 'use-widget' })
    await expect(running).rejects.toBeInstanceOf(UseWidgetError)
    expect(requester.pending).toBeUndefined()
    expect(swapDelivered).not.toHaveBeenCalled()
  })

  it('refuses the operation when no rail can carry the money', async () => {
    const requester = createFundingRequester(account)
    resolvePaymentRail.mockResolvedValue(undefined)
    await expect(requester.request(need)).rejects.toThrow(/No payment route/)
    expect(requester.pending).toBeUndefined()
  })
})
