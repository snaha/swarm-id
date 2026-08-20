<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Utils } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import Info from '@lucide/svelte/icons/info'
  import type { PostageStamp } from '@snaha/swarm-id'

  import { createAttemptTracker } from '$lib/attempt'
  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import DriveInfoStrip from '$lib/components/drive-info-strip.svelte'
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { formatBytes, formatRemaining } from '$lib/drives'
  import { createCostEstimate } from '$lib/payment/cost-estimate.svelte'
  import {
    type OperationStep,
    type ResizePreview,
    previewResize,
    runResize,
  } from '$lib/payment/drive-operation'
  import {
    PaymentCancelledError,
    createFundingRequester,
    describeStep,
  } from '$lib/payment/funding-request.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
  }

  let { account, drive, onClose }: Props = $props()

  type Phase = 'form' | 'pending' | 'success' | 'error'

  // Empty until the user picks a larger size; the current size is the first
  // (default-shown) option, so "no change yet" reads as an empty selection.
  let newDepth = $state('')
  let keepLifespan = $state(true)
  let phase = $state<Phase>('form')
  let errorMessage = $state('')
  let errorDetail = $state('')
  let step = $state<OperationStep>('checking')
  // The steps already finished this attempt, so a failure says what was paid for.
  let history = $state<string[]>([])
  // The plan as the CHAIN sees it (live remaining balance and depth), which is
  // what the operation will actually execute — the stored record can be stale.
  let preview = $state<ResizePreview | undefined>(undefined)
  const attempts = createAttemptTracker()
  const funding = createFundingRequester(() => account)

  // The current size is the default (empty-valued) option; only larger sizes
  // are offered — a batch can grow (dilute) but never shrink.
  const sizeOptions = $derived([
    { value: '', label: formatBytes(Utils.getStampEffectiveBytes(drive.depth)) },
    ...[...Utils.getStampEffectiveBytesBreakpoints(false).entries()]
      .filter(([depth]) => depth > drive.depth)
      .sort(([a], [b]) => a - b)
      .map(([depth, bytes]) => ({ value: String(depth), label: formatBytes(bytes) })),
  ])

  const changed = $derived(newDepth !== '' && Number(newDepth) > drive.depth)

  // Price the selection against chain truth. A failed read only hides the
  // estimate — proceeding re-reads and plans authoritatively.
  //
  // The pending plan is cleared before each read and late replies are dropped:
  // the chain read is async, so keeping the previous plan on screen would
  // price the NEW selection with the OLD plan's numbers for a moment, and two
  // quick changes could otherwise land out of order.
  let previewRequest = 0
  $effect(() => {
    const depth = Number(newDepth)
    const keep = keepLifespan
    preview = undefined
    if (!changed) {
      return
    }
    const request = ++previewRequest
    void previewResize(drive, depth, keep).then((result) => {
      if (request === previewRequest) {
        preview = result
      }
    })
  })

  // Keep-lifespan cost: the top-up is paid at the CURRENT depth (it runs before
  // the depth increase), so that is the depth the cost is spread over — as the
  // CHAIN reports it, since a resize interrupted after its increase leaves the
  // stored record a depth behind and the price out by a factor of 2^Δ.
  const estimate = createCostEstimate(() =>
    preview && preview.plan.topUpAmount > 0n
      ? { depth: preview.currentDepth, amountPerChunk: preview.plan.topUpAmount }
      : undefined,
  )
  /** The estimate as the strip shows it. */
  const estimateLabel = $derived(estimate.value ? `~${estimate.value}` : undefined)

  const reducedLifespan = $derived.by(() => {
    if (!preview || keepLifespan || preview.plan.afterDilute.batchTTL === undefined) {
      return ''
    }
    return formatRemaining(preview.plan.afterDilute.batchTTL).replace(/ left$/, '')
  })

  // The strip above the action: a label, plus the figure that matters on the
  // right when there is one to show.
  const info = $derived.by<{ label: string; value?: string }>(() => {
    if (!changed) {
      return { label: 'No changes made yet' }
    }
    if (preview?.plan.clampedToFloor) {
      return estimateLabel
        ? { label: 'Includes the ~1 day minimum', value: estimateLabel }
        : { label: 'Resizing needs at least ~1 day of lifespan' }
    }
    if (keepLifespan) {
      return estimateLabel
        ? { label: 'Estimated cost', value: estimateLabel }
        : { label: 'Keeps your current lifespan — you pay to top up the larger size' }
    }
    return reducedLifespan
      ? { label: 'Lifespan reduced to', value: `~${reducedLifespan}` }
      : { label: 'Lifespan shortens as the deposit spreads over more storage' }
  })

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
      // Deliberately unguarded: the top-up and the depth increase are on-chain
      // spends whose record updates must land even if the dialog was closed —
      // only the UI epilogue is skipped when superseded. Resume is decided
      // from chain state inside runResize, not from component-local memory.
      await runResize({
        account,
        drive,
        newDepth: Number(newDepth),
        keepLifespan,
        requestFunding: funding.request,
        onStep: (next) => {
          const finished = describeStep(step, 'resize')
          // The initial state and the first reported step describe the same
          // moment; ticking both off would claim a step that never ran.
          if (describeStep(next, 'resize') !== finished) {
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
      errorMessage = caught instanceof Error ? caught.message : 'Could not increase the size.'
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
    pendingLabel={describeStep(step, 'resize')}
    {history}
    {errorMessage}
    errorDetails={errorDetail}
    successTitle="Payment completed!"
    successBody="Your drive is now larger."
    onRetry={() => (phase = 'form')}
    onClose={close}
  />
{:else}
  <Dialog onclose={close} title={drive.name || 'Drive'}>
    <div class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Size up to</span>
      <Select options={sizeOptions} bind:value={newDepth} />
    </div>

    <div class="flex w-full items-center gap-2">
      <Switch bind:checked={keepLifespan} aria-label="Keep current lifespan" />
      <p class="flex-1 text-sm">Keep current lifespan</p>
      <span
        title="Spreading the deposit over more storage shortens the lifespan unless you top up."
      >
        <Info class="text-muted-foreground size-4" />
      </span>
    </div>

    <DriveInfoStrip label={info.label} value={info.value} />

    <Button class="w-full" disabled={!changed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
