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
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { formatBytes, formatRemaining } from '$lib/drives'
  import { type OperationStep, previewResize, runResize } from '$lib/payment/drive-operation'
  import { createFundingRequester, describeStep } from '$lib/payment/funding-request.svelte'
  import { type ResizePlan, stampCostBzz } from '$lib/payment/purchase'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
    onUpdated?: (message: string) => void
  }

  let { account, drive, onClose, onUpdated }: Props = $props()

  type Phase = 'form' | 'pending' | 'error'

  // Empty until the user picks a larger size; the current size is the first
  // (default-shown) option, so "no change yet" reads as an empty selection.
  let newDepth = $state('')
  let keepLifespan = $state(true)
  let phase = $state<Phase>('form')
  let errorMessage = $state('')
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
  $effect(() => {
    const depth = Number(newDepth)
    const keep = keepLifespan
    if (!changed) {
      preview = undefined
      return
    }
    void previewResize(drive, depth, keep).then((result) => {
      preview = result?.plan
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

  const infoText = $derived.by(() => {
    if (!changed) {
      return 'No changes made yet.'
    }
    if (preview?.clampedToFloor) {
      return estimateBzz
        ? `Resizing needs at least ~1 day of lifespan — estimated cost ≈ ${estimateBzz} BZZ`
        : 'Resizing needs at least ~1 day of lifespan, so a small top-up is included.'
    }
    if (keepLifespan) {
      return estimateBzz
        ? `Estimated cost ≈ ${estimateBzz} BZZ`
        : 'Keeps your current lifespan — you pay to top up the larger size.'
    }
    return reducedLifespan
      ? `Lifespan reduced to ~${reducedLifespan}`
      : 'Lifespan shortens as the deposit spreads over more storage.'
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
      onUpdated?.('Drive size increased')
      close()
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not increase the size.'
      phase = 'error'
    }
  }
</script>

{#if funding.pending}
  <PaymentDialog need={funding.pending} onPaid={funding.resolve} onCancel={funding.cancel} />
{:else if phase !== 'form'}
  <DriveDialogStatus
    title={drive.name || 'Drive'}
    {phase}
    pendingLabel={describeStep(step, 'resize')}
    {errorMessage}
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

    <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">{infoText}</p>

    <Button class="w-full" disabled={!changed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
