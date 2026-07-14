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
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { formatBytes, formatRemaining, remainingLifespanSeconds } from '$lib/drives'
  import { diluteStamp, topUpStamp } from '$lib/payment/bee'
  import { type DilutionPlan, dilutedStamp, stampCostBzz } from '$lib/payment/purchase'
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
  const attempts = createAttemptTracker()
  // Set once the dilute has landed on-chain: dilute and top-up are two separate
  // node transactions, so a failed top-up must NOT re-run the dilute on retry
  // (the node rejects a dilution to the batch's now-current depth). While set,
  // the retry completes THIS plan — the form's inputs are locked.
  let committedPlan = $state<DilutionPlan | undefined>(undefined)

  // The current size is the default (empty-valued) option; only larger sizes are
  // offered — Bee can grow a batch (dilute) but not shrink it.
  const sizeOptions = $derived([
    { value: '', label: formatBytes(Utils.getStampEffectiveBytes(drive.depth)) },
    ...[...Utils.getStampEffectiveBytesBreakpoints(false).entries()]
      .filter(([depth]) => depth > drive.depth)
      .sort(([a], [b]) => a - b)
      .map(([depth, bytes]) => ({ value: String(depth), label: formatBytes(bytes) })),
  ])

  const changed = $derived(newDepth !== '' && Number(newDepth) > drive.depth)

  // The dilution plan for the current selection: the node operations' outcomes
  // as local-record patches, plus the compensating top-up when keeping lifespan.
  const plan = $derived(
    changed
      ? dilutedStamp(drive, Number(newDepth), keepLifespan, remainingLifespanSeconds(drive))
      : undefined,
  )

  // Keep-lifespan cost: the top-up spread across the larger (diluted) batch, in BZZ.
  const estimateBzz = $derived(
    plan && keepLifespan ? stampCostBzz(Number(newDepth), plan.topUpAmount) : undefined,
  )

  // Not-keeping cost is free, but the lifespan shrinks — project the reduced span
  // (e.g. "2 months") from the diluted TTL; empty when the TTL is unknown.
  const reducedLifespan = $derived.by(() => {
    if (!plan || keepLifespan || plan.afterDilute.batchTTL === undefined) {
      return ''
    }
    return formatRemaining(plan.afterDilute.batchTTL).replace(/ left$/, '')
  })

  const infoText = $derived.by(() => {
    if (!changed) {
      return 'No changes made yet.'
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
    onClose()
  }

  async function proceed() {
    // Resume a partially-applied plan first; otherwise snapshot the derived one
    // so the amounts applied are exactly the ones the estimate showed.
    const active = committedPlan ?? plan
    if (!active) {
      return
    }
    const attempt = attempts.begin()
    phase = 'pending'
    errorMessage = ''
    // Deliberately no guards on the awaits below: dilute and top-up are
    // on-chain spends whose record updates must land even if the dialog was
    // closed mid-flight — only the UI epilogue is skipped when superseded.
    try {
      const batchId = drive.batchID.toHex()
      if (!committedPlan) {
        // The drive may have been removed meanwhile (another tab, a sync fold) —
        // check before spending on the node against a record we'd never show.
        if (!account.hasLiveStamp(drive.batchID)) {
          throw new Error('This drive was removed in the meantime.')
        }
        await diluteStamp(batchId, Number(newDepth))
        // The dilute is on-chain: record it immediately (a failed top-up must
        // not leave the UI showing the old, un-diluted size/lifespan) and pin
        // the plan so a retry resumes at the top-up.
        committedPlan = active
        account.updateStamp(drive.batchID, active.afterDilute)
      }
      if (active.topUpAmount > 0n) {
        await topUpStamp(batchId, active.topUpAmount)
        account.updateStamp(drive.batchID, active.afterTopUp)
      }
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

{#if phase !== 'form'}
  <DriveDialogStatus
    title={drive.name || 'Drive'}
    {phase}
    pendingLabel={committedPlan ? 'Completing the top-up…' : 'Increasing the drive size…'}
    {errorMessage}
    onRetry={() => (phase = 'form')}
    onClose={close}
  />
{:else}
  <Dialog onclose={close} title={drive.name || 'Drive'}>
    <div class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Size up to</span>
      <Select options={sizeOptions} bind:value={newDepth} disabled={committedPlan !== undefined} />
    </div>

    <div class="flex w-full items-center gap-2">
      <Switch
        bind:checked={keepLifespan}
        disabled={committedPlan !== undefined}
        aria-label="Keep current lifespan"
      />
      <p class="flex-1 text-sm">Keep current lifespan</p>
      <span
        title="Spreading the deposit over more storage shortens the lifespan unless you top up."
      >
        <Info class="text-muted-foreground size-4" />
      </span>
    </div>

    <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">
      {committedPlan
        ? 'The size increase is done; the lifespan top-up is still pending. Proceed to retry it.'
        : infoText}
    </p>

    <Button class="w-full" disabled={!changed && !committedPlan} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
