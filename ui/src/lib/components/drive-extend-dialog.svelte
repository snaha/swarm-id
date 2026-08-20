<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import type { PostageStamp } from '@snaha/swarm-id'

  import { createAttemptTracker } from '$lib/attempt'
  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import DriveInfoStrip from '$lib/components/drive-info-strip.svelte'
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import {
    LIFESPAN_UNIT_OPTIONS,
    type LifespanUnit,
    formatYmd,
    lifespanToSeconds,
    remainingLifespanSeconds,
  } from '$lib/drives'
  import { currentChainPrice } from '$lib/payment/chain-price'
  import { createCostEstimate } from '$lib/payment/cost-estimate.svelte'
  import {
    type OperationStep,
    PaymentCancelledError,
    runExtend,
  } from '$lib/payment/drive-operation'
  import { createFundingRequester, describeStep } from '$lib/payment/funding-request.svelte'
  import { stampAmountForSeconds } from '$lib/payment/purchase'
  import type { Account } from '$lib/types'

  const MS_PER_SECOND = 1000

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
  }

  let { account, drive, onClose }: Props = $props()

  type Phase = 'form' | 'pending' | 'success' | 'error'

  let count = $state('0')
  let unit = $state<LifespanUnit>('months')
  let phase = $state<Phase>('form')
  let errorMessage = $state('')
  let errorDetail = $state('')
  let currentPrice = $state<bigint | undefined>(undefined)
  let step = $state<OperationStep>('checking')
  // The steps already finished this attempt, so a failure says what was paid for.
  let history = $state<string[]>([])
  const attempts = createAttemptTracker()
  // Owns the funding seam: it surfaces the payment dialog and resolves once paid.
  const funding = createFundingRequester(() => account)

  const addedSeconds = $derived(lifespanToSeconds(Number(count), unit))

  const changed = $derived(addedSeconds > 0)
  const estimatedUntil = $derived(
    formatYmd(
      Date.now() +
        (Math.max(0, remainingLifespanSeconds(drive) ?? 0) + addedSeconds) * MS_PER_SECOND,
    ),
  )

  /** Per-chunk PLUR the top-up would cost at the current price. */
  const topUpPerChunk = $derived(
    changed && currentPrice !== undefined
      ? stampAmountForSeconds(currentPrice, addedSeconds)
      : undefined,
  )

  // The top-up is spread over the drive's CURRENT depth — nothing dilutes here.
  const estimate = createCostEstimate(() =>
    topUpPerChunk === undefined ? undefined : { depth: drive.depth, amountPerChunk: topUpPerChunk },
  )

  // Best-effort prefetch for the live estimate; the run fetches for real, so a
  // miss here only hides the estimate.
  $effect(() => {
    currentChainPrice()
      .then((price) => (currentPrice = price))
      .catch(() => undefined)
  })

  function stepDelta(delta: number) {
    count = String(Math.max(0, (Number(count) || 0) + delta))
  }

  function close() {
    attempts.supersede()
    funding.cancel()
    onClose()
  }

  async function proceed() {
    if (!changed) {
      return
    }
    const attempt = attempts.begin()
    phase = 'pending'
    errorMessage = ''
    step = 'checking'
    history = []
    try {
      // Deliberately unguarded: `runExtend` stops itself at its money
      // boundaries via `cancelled` below, and the tail after the send must land
      // even if the dialog was closed — once a transaction is sent the money is
      // spent, so the record has to catch up. Only the UI epilogue below is
      // skipped for a superseded attempt.
      await runExtend({
        account,
        drive,
        addedSeconds,
        requestFunding: funding.request,
        cancelled: () => !attempt.current,
        onStep: (next) => {
          const finished = describeStep(step, 'extend')
          // The initial state and the first reported step describe the same
          // moment; ticking both off would claim a step that never ran.
          if (describeStep(next, 'extend') !== finished) {
            history = [...history, finished]
          }
          step = next
        },
      })
      if (!attempt.current) {
        return
      }
      phase = 'success'
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      // Backing out of the payment is a choice, not a failure — return to the
      // form with the selection intact rather than reporting an error.
      if (caught instanceof PaymentCancelledError) {
        phase = 'form'
        return
      }
      errorDetail = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
      errorMessage = caught instanceof Error ? caught.message : 'Could not extend the lifespan.'
      phase = 'error'
    }
  }
</script>

{#if funding.pending}
  <PaymentDialog
    need={funding.pending.need}
    rail={funding.pending.rail}
    fundingQuote={funding.pending.quote}
    onPaid={funding.resolve}
    onCancel={funding.cancel}
  />
{:else if phase !== 'form'}
  <DriveDialogStatus
    title={drive.name || 'Drive'}
    {phase}
    pendingLabel={describeStep(step, 'extend')}
    {history}
    {errorMessage}
    errorDetails={errorDetail}
    successTitle="Payment completed!"
    successBody="Your drive's lifespan has been extended."
    onRetry={() => (phase = 'form')}
    onClose={close}
  />
{:else}
  <Dialog onclose={close} title={drive.name || 'Drive'}>
    <div class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Extend lifespan by</span>
      <div class="flex w-full items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Decrease"
          disabled={Number(count) <= 0}
          onclick={() => stepDelta(-1)}
        >
          <Minus />
        </Button>
        <Input type="number" min="0" bind:value={count} class="flex-1 text-center" />
        <Button variant="outline" size="icon" aria-label="Increase" onclick={() => stepDelta(1)}>
          <Plus />
        </Button>
        <Select options={LIFESPAN_UNIT_OPTIONS} bind:value={unit} class="w-32" />
      </div>
      <p class="text-muted-foreground text-sm">Estimated until {estimatedUntil}</p>
    </div>

    {#if !changed}
      <DriveInfoStrip label="No changes made yet" />
    {:else if estimate.value}
      <DriveInfoStrip label="Estimated cost" value={`~${estimate.value}`} />
    {:else}
      <DriveInfoStrip label="Final cost is shown at payment" />
    {/if}

    <Button class="w-full" disabled={!changed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
