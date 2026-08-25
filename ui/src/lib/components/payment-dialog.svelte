<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { untrack } from 'svelte'

  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Wallet from '@lucide/svelte/icons/wallet'
  import { TimeoutError } from '@snaha/swarm-id'
  import { formatUnits } from 'viem'

  import { createAttemptTracker } from '$lib/attempt'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { onboard } from '$lib/crypto/onboard'
  import type { FundingNeed } from '$lib/payment/drive-operation'
  import {
    type FundingQuote,
    priceImpactRefusal,
    quoteFunding,
    settleWith,
  } from '$lib/payment/funding'
  import type { CancelOptions } from '$lib/payment/funding-request.svelte'
  import {
    type EthereumProvider,
    type PaymentQuote,
    type PaymentRail,
    displayAmount,
    switchWalletChain,
  } from '$lib/payment/payment-rail'

  /**
   * The payment screens: choose a method, then — for the built-in engine —
   * connect a wallet, pick a source chain and token, review the quoted cost and
   * sign ONE transaction. The rail then delivers xDAI to the drive's
   * batch-owner address on Gnosis; the caller swaps it and runs the postage
   * operation with the owner key.
   *
   * The other method is fund.bzz.limo, which is not a rail and not priced here:
   * it settles the whole purchase in its own popup and hands back a created
   * batch, so choosing it hands control back to the caller (`onUseWidget`)
   * rather than continuing through these screens.
   *
   * Which rail carries the money is the caller's choice (`resolve-rail.ts`),
   * and nothing here depends on which one it is — the screens are identical
   * against Relay and against the local dev rail.
   *
   * The connected wallet only ever signs on the source chain — it never sees
   * the owner key, so passkey and password accounts use this unchanged.
   */
  interface Props {
    need: FundingNeed
    /** The rail this payment is carried by — chains, tokens, quoting, execution. */
    rail: PaymentRail
    /**
     * Resolves the operation's funding request once the payment lands, with the
     * quote the payment was made against.
     */
    onPaid: (settled: FundingQuote) => void
    onCancel: (options?: CancelOptions) => void
    /**
     * Hand the payment to the fund.bzz.limo widget instead. Passed only by
     * callers that widget can serve: its PostageStamp ABI carries `createBatch`
     * alone, so it can buy a drive and can neither extend nor resize one.
     * Absent, the built-in engine is the only method listed.
     */
    onUseWidget?: () => void
  }

  let { need, rail, onPaid, onCancel, onUseWidget }: Props = $props()

  type Screen = 'method' | 'connecting' | 'configure' | 'switching' | 'approving' | 'relaying'
  type Method = 'widget' | 'built-in'

  const GNOSIS_DECIMALS = 18
  const BZZ_DECIMALS = 16

  const WIDGET_LABEL = 'Pay with crypto (fund.bzz.limo)'
  const BUILT_IN_LABEL = 'Pay with crypto (built in, experimental)'

  let screen = $state<Screen>('method')
  let errorMessage = $state('')
  let provider = $state<EthereumProvider | undefined>(undefined)
  let walletAddress = $state('')
  // The rail is fixed for the life of one payment — the dialog is created fresh
  // per pending request — so its first chain and token are read ONCE as the
  // user's starting selection, not tracked.
  let chainId = $state(untrack(() => String(rail.chains[0].id)))
  let tokenAddress = $state(untrack(() => rail.tokens(rail.chains[0].id)[0].address))
  let paymentQuote = $state<PaymentQuote | undefined>(undefined)
  let quoting = $state(false)
  let relayStatus = $state('Cross-swap xDAI on Relay')
  /**
   * The Gnosis-side quote in force, once the built-in method has priced one.
   * Undefined until then — the default method needs no quote of ours, so the
   * method screen is not held behind an RPC round-trip. Replaced only by a
   * re-price after a failed attempt; whichever one the payment is finally made
   * against travels back through `onPaid`, so the amount delivered and the
   * amount swapped stay the same figure.
   */
  let gnosisQuote = $state.raw<FundingQuote | undefined>(undefined)
  /** Which method the chooser is on. Which methods exist is fixed for the life
   * of one payment — the dialog is created fresh per pending request — so this
   * is read ONCE, as the user's starting selection, not tracked. */
  let method = $state<Method>(untrack(() => (onUseWidget ? 'widget' : 'built-in')))
  /** True while `quoteFunding` is pricing the built-in method's side. */
  let pricing = $state(false)
  /** Why the built-in method cannot be used, in the quoter's own words. */
  let builtInRefusal = $state('')
  /**
   * True from the moment the source-chain transaction is handed to the wallet
   * until the rail reports it settled or failed. Cancelling in this window
   * cannot call the wallet back, so it is not a clean cancel.
   */
  let paying = $state(false)
  /**
   * Set once an attempt has been made. From then on the Gnosis side is
   * re-priced before every source-side quote: a failed attempt may still have
   * delivered, and only the owner address knows.
   */
  let attempted = false
  const attempts = createAttemptTracker()

  /**
   * The methods on offer, widget first. A built-in method that failed to price
   * is listed but unchoosable. Where it is the only method there is nothing to
   * fall back to, so it stays choosable and the screen offers a retry.
   */
  const methodOptions = $derived([
    ...(onUseWidget ? [{ value: 'widget', label: WIDGET_LABEL }] : []),
    {
      value: 'built-in',
      label: BUILT_IN_LABEL,
      disabled: onUseWidget !== undefined && builtInRefusal !== '',
    },
  ])

  const chainOptions = $derived(
    rail.chains.map((chain) => ({
      value: String(chain.id),
      label: chain.name,
    })),
  )
  const tokenOptions = $derived(
    rail.tokens(Number(chainId)).map((token) => ({
      value: token.address,
      label: `${token.symbol} (${token.name})`,
    })),
  )
  const tokenSymbol = $derived(
    rail.tokens(Number(chainId)).find((token) => token.address === tokenAddress)?.symbol ?? '',
  )
  const shortAddress = $derived(
    walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : '',
  )

  function formatAmount(value: bigint, decimals: number): string {
    return displayAmount(formatUnits(value, decimals))
  }

  /**
   * Whether the gas is a transaction of its own, in xDAI, alongside the token
   * the user picked. A token cannot pay for its own swap, so anything but xDAI
   * is two legs — and the two are then priced separately rather than as shares
   * of one figure.
   */
  const separateGasLeg = $derived(
    paymentQuote !== undefined &&
      paymentQuote.delivers.input !== 'xdai' &&
      (gnosisQuote?.xdaiForGasWei ?? 0n) > 0n,
  )

  /** The gas leg as it is paid: native xDAI, whatever the other leg is in. */
  const gasLegAmount = $derived(
    `${formatAmount(gnosisQuote?.xdaiForGasWei ?? 0n, GNOSIS_DECIMALS)} xDAI`,
  )

  /**
   * The quoted cost as one line. Two legs are stated as two: the gas is a
   * separate xDAI transaction and does not come out of the token amount beside
   * it, so a headline naming only the token would be short of the bill — and
   * the breakdown rows beneath it would then add up to more than it says.
   */
  const headline = $derived.by(() => {
    if (!paymentQuote) {
      return ''
    }
    const paid = `${paymentQuote.amountFormatted} ${tokenSymbol}`
    return separateGasLeg ? `${paid} + ${gasLegAmount} gas` : paid
  })

  /**
   * What one leg of the funding costs in the token the user is paying with —
   * its share of the quoted total, as the designs show each breakdown row
   * priced in the source token. Only for a single-leg (xDAI) payment: with a
   * separate gas leg each row is paid in its own asset and there is nothing to
   * apportion.
   *
   * Shares are taken against the sum of the legs, not the amount delivered:
   * when xDAI stranded at the owner address covers part of the operation the
   * two differ, and dividing by the smaller figure would make the rows add up
   * to more than the user is actually paying.
   */
  function shareOfTotal(partWei: bigint): string {
    if (!gnosisQuote) {
      return ''
    }
    const total = gnosisQuote.xdaiForBzzWei + gnosisQuote.xdaiForGasWei
    const paid = Number(paymentQuote?.amountFormatted ?? '')
    if (total === 0n || !Number.isFinite(paid) || paid === 0) {
      return ''
    }
    const share = displayAmount((paid * Number(partWei)) / Number(total))
    return share ? `${share} ${tokenSymbol}` : ''
  }

  /**
   * Price the built-in method's Gnosis side. Deferred to the moment that method
   * is chosen (or, where it is the only one, to the dialog opening): the
   * default method is settled entirely by fund.bzz.limo and needs nothing from
   * `quoteFunding`.
   */
  async function priceBuiltIn() {
    const attempt = attempts.begin()
    builtInRefusal = ''
    errorMessage = ''
    pricing = true
    try {
      const quoted = await attempt.guard(quoteFunding(need))
      // Nothing left to collect: xDAI already at the owner address covers the
      // whole operation, so a pay screen here would be asking the user for
      // zero. Settle instead, and the swap spends what is already there.
      if (quoted.xdaiWei === 0n) {
        onPaid(quoted)
        return
      }
      gnosisQuote = quoted
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      // Only this method is out. fund.bzz.limo prices nothing through us, so it
      // is unaffected — fall back to it where it is offered, rather than
      // leaving the user on a method that cannot proceed.
      builtInRefusal = caught instanceof Error ? caught.message : 'Could not price this payment.'
      if (onUseWidget) {
        method = 'widget'
      }
    } finally {
      if (attempt.current) {
        pricing = false
      }
    }
  }

  /** Price the built-in method the first time it is selected. */
  function chooseMethod() {
    if (method === 'built-in' && !gnosisQuote && !pricing) {
      void priceBuiltIn()
    }
  }

  async function connect() {
    const attempt = attempts.begin()
    errorMessage = ''
    screen = 'connecting'
    try {
      const connected = await attempt.guard(onboard.connectWallet())
      const wallet = connected[0]
      const address = wallet?.accounts[0]?.address
      if (!wallet || !address) {
        throw new Error('No wallet connected. Select a wallet and try again.')
      }
      provider = wallet.provider as unknown as EthereumProvider
      walletAddress = address

      // Adding a network is what makes the wallet show a balance for it at all,
      // so it is offered here rather than at Pay. A refusal is not fatal — they
      // may mean to pay from somewhere else, and `pay()` asks again for
      // whichever chain they land on.
      screen = 'switching'
      await attempt.guard(
        switchWalletChain(provider, Number(chainId), rail.chains).catch(() => undefined),
      )

      screen = 'configure'
      void refreshQuote()
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not connect the wallet.'
      screen = 'method'
    }
  }

  /**
   * Price the payment for the current selection — on connect, whenever the
   * chain or token changes, and after a failed attempt.
   *
   * Once anything has been signed the Gnosis side is re-priced first, because a
   * failure is not proof that nothing was delivered: a transfer whose
   * confirmation wait timed out is the ordinary case, and `quoteFunding`
   * subtracts what is now at the owner address. So the retry asks only for what
   * is genuinely still missing — and when the failed attempt covered the
   * operation in full, there is nothing left to charge for and the payment is
   * settled rather than taken again.
   *
   * @param failure - message from the attempt that led here, kept visible under
   *   the re-priced cost.
   */
  async function refreshQuote(failure = '') {
    // The Gnosis side in force, kept as a local: it is replaced mid-flight by
    // the re-price below, and every figure handed to the rail must come from
    // the same one.
    let priced = gnosisQuote
    if (!walletAddress || !priced) {
      return
    }
    const attempt = attempts.begin()
    // Both props are getters into the caller's pending request, which is gone
    // the moment the dialog is — read them before the first await.
    const { destination } = need
    const currentRail = rail
    quoting = true
    paymentQuote = undefined
    errorMessage = failure
    try {
      if (attempted) {
        const repriced = await attempt.guard(quoteFunding(need))
        if (repriced.xdaiWei === 0n) {
          onPaid(repriced)
          return
        }
        gnosisQuote = repriced
        priced = repriced
      }
      const quote = await attempt.guard(
        currentRail.quote({
          chainId: Number(chainId),
          currency: tokenAddress,
          user: walletAddress,
          recipient: destination,
          xdaiWei: priced.xdaiWei,
          bzzPlur: priced.bzzPlur,
          gasXdaiWei: priced.xdaiForGasWei,
        }),
      )
      // The pool's price impact is the SWAP's problem, so it is judged here,
      // where the token is known, rather than at quoting time: a payment made
      // in BZZ touches no pool and must stay available at any size. Leaving
      // `paymentQuote` unset is what keeps Pay disabled.
      const refusal =
        quote.delivers.input === 'bzz' ? undefined : priceImpactRefusal(priced.priceImpactPercent)
      if (refusal) {
        errorMessage = refusal
        return
      }
      paymentQuote = quote
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      // Pay stays disabled without a quote, which is what a failed re-price
      // needs too: the old price cannot be offered again while it is unknown
      // whether the last attempt delivered.
      errorMessage =
        caught instanceof Error ? caught.message : 'No payment route available for this token.'
    } finally {
      if (attempt.current) {
        quoting = false
      }
    }
  }

  async function pay() {
    const quote = paymentQuote
    const priced = gnosisQuote
    if (!provider || !quote || !priced) {
      return
    }
    const attempt = attempts.begin()
    errorMessage = ''
    try {
      screen = 'switching'
      await attempt.guard(switchWalletChain(provider, Number(chainId), rail.chains))
      screen = 'approving'
      attempted = true
      paying = true
      // Deliberately unguarded: once the user signs, the payment is in flight
      // and must be seen through — a cancel takes the screens away but leaves
      // this running.
      await rail.execute({
        quote,
        provider,
        chainId: Number(chainId),
        currency: tokenAddress,
        address: walletAddress,
        onStatus: (status) => {
          if (attempt.current) {
            relayStatus = status
            screen = 'relaying'
          }
        },
      })
      paying = false
      // Not attempt-gated: the money has moved, so the settlement is handed on
      // even when the user cancelled while the wallet held the request —
      // otherwise the payment lands with nothing recorded and nothing shown.
      //
      // The rail's own account of what it delivered rides along, because the
      // swap that follows spends exactly that: paying in USDC and then trying
      // to swap xDAI would fail at the far end of a payment that succeeded.
      onPaid(settleWith(priced, quote.delivers))
    } catch (caught) {
      paying = false
      const failure = caught instanceof Error ? caught.message : 'The payment failed.'
      if (!attempt.current) {
        // Cancelled while this was in flight, and it came back a failure. A
        // timeout means the transfer was BROADCAST — the wait screen promised
        // an approved payment still counts — so the request fails with the
        // rail's own words, and the retry re-prices against whatever landed
        // rather than charging for it twice. Anything else is the user's own
        // "no" in the wallet: nothing was sent, so let the operation go.
        onCancel(
          caught instanceof TimeoutError
            ? { reason: 'payment-unconfirmed', error: caught }
            : { reason: 'wallet-rejected' },
        )
        return
      }
      screen = 'configure'
      await refreshQuote(failure)
    }
  }

  function cancel() {
    attempts.supersede()
    onCancel(paying ? { reason: 'payment-in-flight' } : undefined)
  }

  function back() {
    if (screen === 'configure') {
      screen = 'method'
      return
    }
    cancel()
  }

  // Extend and resize list no widget, so the built-in method is the selection
  // from the outset — price it now rather than wait for a choice there is no
  // way to make. Buying a drive starts on the widget and prices nothing. Read
  // once, at setup: a later switch to the built-in method prices through
  // `chooseMethod`, not here.
  if (untrack(() => method) === 'built-in') {
    void priceBuiltIn()
  }
</script>

{#if screen === 'connecting' || screen === 'switching' || screen === 'approving' || screen === 'relaying'}
  <Dialog onclose={cancel} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-6 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      {#if screen === 'relaying'}
        <p class="text-sm">{relayStatus}</p>
      {:else}
        <p class="text-base font-medium">Check your wallet</p>
        <p class="text-muted-foreground text-sm">
          {screen === 'connecting'
            ? 'Approve the connection in your wallet.'
            : screen === 'switching'
              ? 'Confirm the network change in your wallet.'
              : separateGasLeg
                ? 'This payment is two transactions: approve the gas in your wallet first, then the payment itself.'
                : 'Approve the payment in your wallet.'}
        </p>
      {/if}
    </div>
    <!-- On every wait, the relaying one included: a rail that stops reporting
         must not leave a reload as the only way out. -->
    <Button variant="outline" class="w-full" onclick={cancel}>Cancel</Button>
    {#if paying}
      <p class="text-muted-foreground w-full text-center text-xs">
        Cancelling cannot stop a payment you have already approved. If it goes through it still pays
        for this drive — you will not be charged for it twice.
      </p>
    {/if}
  </Dialog>
{:else}
  <Dialog onclose={cancel} title={screen === 'method' ? 'Payment' : 'Pay with crypto'}>
    {#snippet leading()}
      <Button
        variant="ghost"
        size="icon"
        class="-mt-1.5 -ml-1.5 size-6 rounded-md [&_svg]:size-3.5"
        aria-label="Back"
        onclick={back}
      >
        <ArrowLeft />
      </Button>
    {/snippet}

    {#if screen === 'method' || !gnosisQuote}
      <div class="flex w-full flex-col gap-2">
        <span class="text-sm font-medium">Method</span>
        <Select options={methodOptions} bind:value={method} onchange={chooseMethod} />
      </div>
      {#if method === 'widget'}
        <p class="bg-muted rounded-md px-3 py-2 text-sm">
          {builtInRefusal ||
            'fund.bzz.limo opens in a popup and picks the drive’s size and lifespan itself, so the ones on the form are only an estimate of what you will pay.'}
        </p>
        <Button class="w-full" onclick={() => onUseWidget?.()}>
          Continue to fund.bzz.limo
          <ArrowRight />
        </Button>
      {:else if builtInRefusal}
        <!-- Reachable only where this is the sole method; with a widget beside
             it the chooser has already fallen back to that one. -->
        <p class="text-destructive w-full text-sm">{builtInRefusal}</p>
        <Button class="w-full" onclick={() => void priceBuiltIn()}>Try again</Button>
      {:else}
        <p class="bg-muted rounded-md px-3 py-2 text-sm">
          {errorMessage || (pricing ? 'Checking the price…' : 'Connect wallet to proceed')}
        </p>
        <Button class="w-full" disabled={pricing || !gnosisQuote} onclick={connect}>
          Connect wallet
          <ArrowRight />
        </Button>
      {/if}
    {:else}
      <div
        class="bg-muted flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-sm"
      >
        <span class="flex items-center gap-2">
          <Wallet class="size-4" />
          Connected wallet
        </span>
        <span class="font-medium">{shortAddress}</span>
      </div>

      <div class="flex w-full flex-col gap-2">
        <span class="text-sm font-medium">Chain</span>
        <Select
          options={chainOptions}
          bind:value={chainId}
          onchange={() => {
            tokenAddress = rail.tokens(Number(chainId))[0]?.address ?? ''
            void refreshQuote()
          }}
        />
      </div>

      <div class="flex w-full flex-col gap-2">
        <span class="text-sm font-medium">Token</span>
        <Select options={tokenOptions} bind:value={tokenAddress} onchange={() => refreshQuote()} />
      </div>

      <div class="bg-muted w-full rounded-md px-3 py-2 text-sm">
        <div class="flex items-center justify-between gap-2">
          <span>Estimated cost</span>
          <span class="font-medium">
            {#if quoting}
              …
            {:else if headline}
              {headline}
            {:else}
              —
            {/if}
          </span>
        </div>
        <div class="text-muted-foreground mt-2 flex flex-col gap-1 text-xs">
          {#if gnosisQuote.bzzPlur > 0n}
            <div class="flex items-center justify-between gap-2">
              <span>{formatAmount(gnosisQuote.bzzPlur, BZZ_DECIMALS)} xBZZ</span>
              <span>
                {#if separateGasLeg}
                  {paymentQuote?.amountFormatted}
                  {tokenSymbol}
                {:else}
                  {shareOfTotal(gnosisQuote.xdaiForBzzWei)}
                {/if}
              </span>
            </div>
          {/if}
          {#if gnosisQuote.xdaiForGasWei > 0n}
            <div class="flex items-center justify-between gap-2">
              <span>{gasLegAmount}</span>
              <span>
                {#if separateGasLeg}
                  {gasLegAmount}
                {:else}
                  {shareOfTotal(gnosisQuote.xdaiForGasWei)}
                {/if}
              </span>
            </div>
          {/if}
        </div>
      </div>

      {#if paymentQuote?.amountUsd}
        <p class="text-muted-foreground w-full text-right text-xs">
          ~{paymentQuote.amountUsd} USD total
        </p>
      {/if}

      {#if errorMessage}
        <p class="text-destructive w-full text-sm">{errorMessage}</p>
      {/if}

      <Button class="w-full" disabled={!paymentQuote || quoting} onclick={pay}>
        Pay with your wallet
      </Button>
    {/if}
  </Dialog>
{/if}
