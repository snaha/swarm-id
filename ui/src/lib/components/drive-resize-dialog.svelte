<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Utils } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import Info from '@lucide/svelte/icons/info'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import type { PostageStamp } from '@snaha/swarm-id'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { formatBytes, formatRemaining } from '$lib/drives'
  import { diluteStamp, topUpStamp } from '$lib/payment/bee'
  import { dilutedStamp } from '$lib/payment/purchase'
  import type { Account } from '$lib/types'

  const COST_SIGNIFICANT_DIGITS = 4

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
  let attempt = 0

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

  // The dilution plan for the current selection: the patched batch fields and, when
  // keeping the lifespan, the compensating per-chunk top-up the user pays for.
  const plan = $derived(changed ? dilutedStamp(drive, Number(newDepth), keepLifespan) : undefined)

  // Keep-lifespan cost: the top-up spread across the larger (diluted) batch, in BZZ.
  const estimateBzz = $derived.by(() => {
    if (!plan || !keepLifespan || plan.topUpAmount <= 0n) {
      return undefined
    }
    try {
      return Utils.getStampCost(Number(newDepth), plan.topUpAmount).toSignificantDigits(
        COST_SIGNIFICANT_DIGITS,
      )
    } catch {
      return undefined
    }
  })

  // Not-keeping cost is free, but the lifespan shrinks — project the reduced span
  // (e.g. "2 months") from the diluted batchTTL; empty when the TTL is unknown.
  const reducedLifespan = $derived.by(() => {
    if (!plan || keepLifespan || plan.update.batchTTL === undefined) {
      return ''
    }
    return formatRemaining(plan.update.batchTTL).replace(/ left$/, '')
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
    attempt++
    onClose()
  }

  async function proceed() {
    if (!changed) {
      return
    }
    const myAttempt = ++attempt
    phase = 'pending'
    errorMessage = ''
    try {
      const depth = Number(newDepth)
      const batchId = drive.batchID.toHex()
      await diluteStamp(batchId, depth)
      const { update, topUpAmount } = dilutedStamp(drive, depth, keepLifespan)
      if (topUpAmount > 0n) {
        await topUpStamp(batchId, topUpAmount)
      }
      if (myAttempt !== attempt) {
        return
      }
      account.updateStamp(drive.batchID, update)
      onUpdated?.('Drive size increased')
      close()
    } catch (caught) {
      if (myAttempt !== attempt) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not increase the size.'
      phase = 'error'
    }
  }
</script>

{#if phase === 'pending'}
  <Dialog onclose={close} dismissable={false} title={drive.name || 'Drive'}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm">Increasing the drive size…</p>
    </div>
  </Dialog>
{:else if phase === 'error'}
  <Dialog onclose={close} title={drive.name || 'Drive'}>
    <div class="flex items-start gap-2">
      <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      <p class="text-sm">{errorMessage}</p>
    </div>
    <div class="flex w-full flex-col gap-2">
      <Button class="w-full" onclick={() => (phase = 'form')}>Try again</Button>
      <Button variant="outline" class="w-full" onclick={close}>Close</Button>
    </div>
  </Dialog>
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
