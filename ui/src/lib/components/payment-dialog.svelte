<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Wallet from '@lucide/svelte/icons/wallet'
  import { formatUnits } from 'viem'

  import { createAttemptTracker } from '$lib/attempt'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { onboard } from '$lib/crypto/onboard'
  import type { FundingNeed } from '$lib/payment/drive-operation'
  import { type FundingQuote, quoteFunding } from '$lib/payment/funding'
  import {
    type EthereumProvider,
    PAYMENT_CHAINS,
    PAYMENT_TOKENS,
    type PaymentQuote,
    executePayment,
    quotePayment,
    switchWalletChain,
  } from '$lib/payment/relay'

  /**
   * The shared "Pay with crypto" flow: connect a wallet, pick a source chain
   * and token, review the quoted cost, sign ONE transaction. Relay then
   * delivers xDAI to the drive's batch-owner address on Gnosis; the caller
   * swaps it and runs the postage operation with the owner key.
   *
   * The connected wallet only ever signs on the source chain — it never sees
   * the owner key, so passkey and password accounts use this unchanged.
   */
  interface Props {
    need: FundingNeed
    /** Resolves the operation's funding request once the payment lands. */
    onPaid: () => void
    onCancel: () => void
  }

  let { need, onPaid, onCancel }: Props = $props()

  type Screen = 'method' | 'connecting' | 'configure' | 'switching' | 'approving' | 'relaying'

  const GNOSIS_DECIMALS = 18
  const BZZ_DECIMALS = 16
  const AMOUNT_DIGITS = 4

  let screen = $state<Screen>('method')
  let errorMessage = $state('')
  let provider = $state<EthereumProvider | undefined>(undefined)
  let walletAddress = $state('')
  let chainId = $state(String(PAYMENT_CHAINS[0].id))
  let tokenAddress = $state(PAYMENT_TOKENS[PAYMENT_CHAINS[0].id][0].address)
  let fundingQuote = $state<FundingQuote | undefined>(undefined)
  let paymentQuote = $state<PaymentQuote | undefined>(undefined)
  let quoting = $state(false)
  let relayStatus = $state('Cross-swap xDAI on Relay')
  const attempts = createAttemptTracker()

  const chainOptions = PAYMENT_CHAINS.map((chain) => ({
    value: String(chain.id),
    label: chain.name,
  }))
  const tokenOptions = $derived(
    (PAYMENT_TOKENS[Number(chainId)] ?? []).map((token) => ({
      value: token.address,
      label: token.symbol,
    })),
  )
  const shortAddress = $derived(
    walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : '',
  )

  function formatAmount(value: bigint, decimals: number): string {
    const asNumber = Number(formatUnits(value, decimals))
    return asNumber.toPrecision(AMOUNT_DIGITS).replace(/\.?0+$/, '')
  }

  /** Price the Gnosis side once — the same xDAI target drives every quote. */
  async function loadFundingQuote() {
    fundingQuote ??= await quoteFunding(need)
    return fundingQuote
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
      const funding = await attempt.guard(loadFundingQuote())
      const quote = await attempt.guard(
        quotePayment({
          chainId: Number(chainId),
          currency: tokenAddress,
          user: walletAddress,
          recipient: need.destination,
          xdaiWei: funding.xdaiWei,
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
      await attempt.guard(switchWalletChain(provider, Number(chainId)))
      screen = 'approving'
      // Deliberately unguarded: once the user signs, the payment is in flight
      // and must be seen through — only the UI epilogue is attempt-gated.
      await executePayment(quote, provider, Number(chainId), walletAddress, (status) => {
        if (attempt.current) {
          relayStatus = status
          screen = 'relaying'
        }
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
        <Select options={[{ value: 'crypto', label: 'Pay with crypto' }]} value="crypto" />
      </div>
      <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">
        {errorMessage || 'Connect wallet to proceed'}
      </p>
      <Button class="w-full" onclick={connect}>Connect wallet</Button>
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
            tokenAddress = (PAYMENT_TOKENS[Number(chainId)] ?? [])[0]?.address ?? ''
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
              {tokenOptions.find((option) => option.value === tokenAddress)?.label}
            {:else}
              —
            {/if}
          </span>
        </div>
        {#if fundingQuote}
          <div class="text-muted-foreground mt-2 flex flex-col gap-1 text-xs">
            {#if fundingQuote.bzzPlur > 0n}
              <div class="flex items-center justify-between gap-2">
                <span>{formatAmount(fundingQuote.bzzPlur, BZZ_DECIMALS)} xBZZ</span>
                <span>storage</span>
              </div>
            {/if}
            {#if fundingQuote.xdaiForGasWei > 0n}
              <div class="flex items-center justify-between gap-2">
                <span>{formatAmount(fundingQuote.xdaiForGasWei, GNOSIS_DECIMALS)} xDAI</span>
                <span>network fees</span>
              </div>
            {/if}
          </div>
        {/if}
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
