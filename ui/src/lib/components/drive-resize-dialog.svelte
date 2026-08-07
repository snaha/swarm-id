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
  import {
    type OperationStep,
    SizeIncreasePendingError,
    previewResize,
    runResize,
  } from '$lib/payment/drive-operation'
  import { createFundingRequester, describeStep } from '$lib/payment/funding-request.svelte'
  import { type ResizePlan, stampCostBzz } from '$lib/payment/purchase'
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
  let errorTone = $state<'error' | 'notice'>('error')
  let step = $state<OperationStep>('checking')
  // The plan as the CHAIN sees it (live remaining balance), which is what the
  // operation will actually execute — the stored record can be stale.
  let preview = $state<ResizePlan | undefined>(undefined)
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
        preview = result?.plan
      }
    })
  })

  // Keep-lifespan cost: the top-up is paid at the CURRENT depth (it runs before
  // the depth increase), so that is the depth the cost is spread over.
  const estimateBzz = $derived(
    preview && preview.topUpAmount > 0n
      ? stampCostBzz(drive.depth, preview.topUpAmount)
      : undefined,
  )

  const reducedLifespan = $derived.by(() => {
    if (!preview || keepLifespan || preview.afterDilute.batchTTL === undefined) {
      return ''
    }
    return formatRemaining(preview.afterDilute.batchTTL).replace(/ left$/, '')
  })

  // The strip above the action: a label, plus the figure that matters on the
  // right when there is one to show.
  const info = $derived.by<{ label: string; value?: string }>(() => {
    if (!changed) {
      return { label: 'No changes made yet' }
    }
    if (preview?.clampedToFloor) {
      return estimateBzz
        ? { label: 'Includes the ~1 day minimum', value: `~${estimateBzz} BZZ` }
        : { label: 'Resizing needs at least ~1 day of lifespan' }
    }
    if (keepLifespan) {
      return estimateBzz
        ? { label: 'Estimated cost', value: `~${estimateBzz} BZZ` }
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
    errorTone = 'error'
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
        onStep: (next) => (step = next),
      })
      if (!attempt.current) {
        return
      }
      phase = 'success'
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      // A pending size increase is not a loss — the payment landed and the
      // lifespan grew, so it gets the benign presentation and its own wording
      // rather than the generic failure surface (#392).
      errorTone = caught instanceof SizeIncreasePendingError ? 'notice' : 'error'
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
    onPaid={funding.resolve}
    onCancel={funding.cancel}
  />
{:else if phase !== 'form'}
  <DriveDialogStatus
    title={drive.name || 'Drive'}
    {phase}
    pendingLabel={describeStep(step, 'resize')}
    {errorMessage}
    errorDetails={errorDetail}
    tone={errorTone}
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
