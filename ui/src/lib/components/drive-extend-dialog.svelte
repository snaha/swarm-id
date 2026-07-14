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
  import { topUpStamp } from '$lib/payment/bee'
  import { currentChainPrice } from '$lib/payment/chain-price'
  import { extendedStamp, stampAmountForSeconds, stampCostBzz } from '$lib/payment/purchase'
  import type { Account } from '$lib/types'

  const MS_PER_SECOND = 1000

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
    onUpdated?: (message: string) => void
  }

  let { account, drive, onClose, onUpdated }: Props = $props()

  type Phase = 'form' | 'pending' | 'error'

  let count = $state('0')
  let unit = $state<LifespanUnit>('months')
  let phase = $state<Phase>('form')
  let errorMessage = $state('')
  let currentPrice = $state<bigint | undefined>(undefined)
  const attempts = createAttemptTracker()

  const addedSeconds = $derived(lifespanToSeconds(Number(count), unit))

  const changed = $derived(addedSeconds > 0)
  const estimatedUntil = $derived(
    formatYmd(
      Date.now() +
        (Math.max(0, remainingLifespanSeconds(drive) ?? 0) + addedSeconds) * MS_PER_SECOND,
    ),
  )

  const estimateBzz = $derived.by(() => {
    if (!changed || currentPrice === undefined) {
      return undefined
    }
    return stampCostBzz(drive.depth, stampAmountForSeconds(currentPrice, addedSeconds))
  })

  // Best-effort prefetch for the live estimate; proceed() fetches for real (and
  // therefore retries after a failure), so a miss here only hides the estimate.
  $effect(() => {
    currentChainPrice()
      .then((price) => (currentPrice = price))
      .catch(() => undefined)
  })

  function step(delta: number) {
    count = String(Math.max(0, (Number(count) || 0) + delta))
  }

  function close() {
    attempts.supersede()
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
      // Guarded: closing during the price fetch must not go on to spend.
      const price = (currentPrice ??= await attempt.guard(currentChainPrice()))
      const topUpAmount = stampAmountForSeconds(price, addedSeconds)
      // The drive may have been removed meanwhile (another tab, a sync fold) —
      // check before spending on the node against a record we'd never show.
      if (!account.hasLiveStamp(drive.batchID)) {
        throw new Error('This drive was removed in the meantime.')
      }
      // Deliberately unguarded from here: once the top-up is sent the money is
      // spent, so the record update must land even if the dialog was closed —
      // only the UI epilogue below is skipped for a superseded attempt.
      await topUpStamp(drive.batchID.toHex(), topUpAmount)
      account.updateStamp(
        drive.batchID,
        extendedStamp(drive, addedSeconds, topUpAmount, remainingLifespanSeconds(drive)),
      )
      if (!attempt.current) {
        return
      }
      onUpdated?.('Lifespan extended')
      close()
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not extend the lifespan.'
      phase = 'error'
    }
  }
</script>

{#if phase !== 'form'}
  <DriveDialogStatus
    title={drive.name || 'Drive'}
    {phase}
    pendingLabel="Extending the lifespan…"
    {errorMessage}
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
          onclick={() => step(-1)}
        >
          <Minus />
        </Button>
        <Input type="number" min="0" bind:value={count} class="flex-1 text-center" />
        <Button variant="outline" size="icon" aria-label="Increase" onclick={() => step(1)}>
          <Plus />
        </Button>
        <Select options={LIFESPAN_UNIT_OPTIONS} bind:value={unit} class="w-32" />
      </div>
      <p class="text-muted-foreground text-sm">Estimated until {estimatedUntil}</p>
    </div>

    <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">
      {!changed
        ? 'No changes made yet.'
        : estimateBzz
          ? `Estimated cost ≈ ${estimateBzz} BZZ`
          : 'Final cost is shown at payment.'}
    </p>

    <Button class="w-full" disabled={!changed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
