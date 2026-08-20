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
  import { formatUnits } from 'viem'

  import { createAttemptTracker } from '$lib/attempt'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { onboard } from '$lib/crypto/onboard'
  import type { FundingNeed } from '$lib/payment/drive-operation'
  import type { FundingQuote } from '$lib/payment/funding'
  import {
    type EthereumProvider,
    type PaymentQuote,
    type PaymentRail,
    displayAmount,
    switchWalletChain,
  } from '$lib/payment/payment-rail'

  /**
   * The shared "Pay with crypto" flow: connect a wallet, pick a source chain
   * and token, review the quoted cost, sign ONE transaction. The rail then
   * delivers xDAI to the drive's batch-owner address on Gnosis; the caller
   * swaps it and runs the postage operation with the owner key.
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
     * The Gnosis-side quote this payment must satisfy, priced by the caller.
     * Handed down rather than re-derived here: the amount the rail is asked to
     * deliver has to be the same one that is later swapped, and two independent
     * quotes of the same need drift as the pool moves.
     */
    fundingQuote: FundingQuote
    /** Resolves the operation's funding request once the payment lands. */
    onPaid: () => void
    onCancel: () => void
    /**
     * Offer the proven multichain-widget flow as the "Pay with crypto" method,
     * beside the in-app one. Only purchases can take it — the widget settles a
     * whole batch, not an arbitrary funding need — so extend and resize leave
     * this unset and the picker offers the in-app flow alone. Choosing it hands
     * the flow back to the caller, which abandons this funding request and
     * drives the widget instead.
     */
    onPayWithWidget?: () => void
  }

  let { need, rail, fundingQuote, onPaid, onCancel, onPayWithWidget }: Props = $props()

  type Screen = 'method' | 'connecting' | 'configure' | 'switching' | 'approving' | 'relaying'

  const GNOSIS_DECIMALS = 18
  const BZZ_DECIMALS = 16

  type Method = 'widget' | 'in-app'

  const IN_APP_METHOD_OPTION = { value: 'in-app', label: 'Pay with crypto in app (experimental)' }
  const methodOptions = $derived(
    onPayWithWidget
      ? [{ value: 'widget', label: 'Pay with crypto' }, IN_APP_METHOD_OPTION]
      : [IN_APP_METHOD_OPTION],
  )

  let screen = $state<Screen>('method')
  // The proven path leads wherever it is available; the in-app flow is the
  // experimental alternative, not the default.
  let method = $state<Method>(untrack(() => (onPayWithWidget ? 'widget' : 'in-app')))
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
  const attempts = createAttemptTracker()

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

  /**
   * Through `displayAmount`, not a local copy of it. The copy this replaces had
   * lost the "only trim after a decimal point" guard, so a four-significant-
   * digit integer lost its real zeros: 1230 rendered as 123.
   */
  function formatAmount(value: bigint, decimals: number): string {
    return displayAmount(formatUnits(value, decimals))
  }

  /**
   * What one leg of the funding costs in the token the user is paying with —
   * its share of the quoted total, as the designs show each breakdown row
   * priced in the source token.
   *
   * Shares are taken against the sum of the legs, not the amount delivered:
   * when xDAI stranded at the owner address covers part of the operation the
   * two differ, and dividing by the smaller figure would make the rows add up
   * to more than the user is actually paying.
   */
  function shareOfTotal(partWei: bigint): string {
    const total = fundingQuote.xdaiForBzzWei + fundingQuote.xdaiForGasWei
    const paid = Number(paymentQuote?.amountFormatted ?? '')
    if (total === 0n || !Number.isFinite(paid) || paid === 0) {
      return ''
    }
    const share = displayAmount((paid * Number(partWei)) / Number(total))
    return share ? `${share} ${tokenSymbol}` : ''
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

      // Offer the chain now rather than at Pay. Adding a network is what makes
      // the wallet show a balance for it at all, so doing it at the end left
      // people looking at an account that appeared to hold nothing. A refusal
      // is not fatal — they may mean to pay from somewhere else, and `pay()`
      // asks again for whichever chain they land on.
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

  /** Re-quote whenever the chain or token selection changes. */
  async function refreshQuote() {
    if (!walletAddress) {
      return
    }
    const attempt = attempts.begin()
    quoting = true
    paymentQuote = undefined
    errorMessage = ''
    try {
      const quote = await attempt.guard(
        rail.quote({
          chainId: Number(chainId),
          currency: tokenAddress,
          user: walletAddress,
          recipient: need.destination,
          xdaiWei: fundingQuote.xdaiWei,
        }),
      )
      paymentQuote = quote
    } catch (caught) {
      if (!attempt.current) {
        return
      }
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
    if (!provider || !quote) {
      return
    }
    const attempt = attempts.begin()
    errorMessage = ''
    try {
      screen = 'switching'
      await attempt.guard(switchWalletChain(provider, Number(chainId), rail.chains))
      screen = 'approving'
      // Deliberately unguarded: once the user signs, the payment is in flight
      // and must be seen through — only the UI epilogue is attempt-gated.
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
      if (!attempt.current) {
        return
      }
      onPaid()
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'The payment failed.'
      screen = 'configure'
    }
  }

  function cancel() {
    attempts.supersede()
    onCancel()
  }

  function back() {
    if (screen === 'configure') {
      screen = 'method'
      return
    }
    cancel()
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
              : 'Approve the payment in your wallet.'}
        </p>
      {/if}
    </div>
    {#if screen !== 'relaying'}
      <Button variant="outline" class="w-full" onclick={cancel}>Cancel</Button>
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

    {#if screen === 'method'}
      <div class="flex w-full flex-col gap-2">
        <span class="text-sm font-medium">Method</span>
        <Select options={methodOptions} bind:value={method} />
      </div>
      <p class="bg-muted rounded-md px-3 py-2 text-sm">
        {errorMessage ||
          (method === 'widget'
            ? 'The payment continues in a popup window'
            : 'Connect wallet to proceed')}
      </p>
      {#if method === 'widget'}
        <Button class="w-full" onclick={() => onPayWithWidget?.()}>
          Continue
          <ArrowRight />
        </Button>
      {:else}
        <Button class="w-full" onclick={connect}>
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
            {:else if paymentQuote}
              {paymentQuote.amountFormatted}
              {tokenSymbol}
            {:else}
              —
            {/if}
          </span>
        </div>
        <div class="text-muted-foreground mt-2 flex flex-col gap-1 text-xs">
          {#if fundingQuote.bzzPlur > 0n}
            <div class="flex items-center justify-between gap-2">
              <span>{formatAmount(fundingQuote.bzzPlur, BZZ_DECIMALS)} xBZZ</span>
              <span>{shareOfTotal(fundingQuote.xdaiForBzzWei)}</span>
            </div>
          {/if}
          {#if fundingQuote.xdaiForGasWei > 0n}
            <div class="flex items-center justify-between gap-2">
              <span>{formatAmount(fundingQuote.xdaiForGasWei, GNOSIS_DECIMALS)} xDAI</span>
              <span>{shareOfTotal(fundingQuote.xdaiForGasWei)}</span>
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
