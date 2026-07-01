<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Utils } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import {
    DEFAULT_BEE_NODE_URL,
    type PostageStamp,
    calculateStampAmountForDays,
    fetchChainState,
  } from '@snaha/swarm-id'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { formatYmd } from '$lib/drives'
  import { topUpStamp } from '$lib/payment/bee'
  import { extendedStamp } from '$lib/payment/purchase'
  import type { Account } from '$lib/types'

  const SECONDS_PER_DAY = 24 * 60 * 60
  const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY
  const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY
  const COST_SIGNIFICANT_DIGITS = 4

  const UNIT_OPTIONS = [
    { value: 'days', label: 'days' },
    { value: 'months', label: 'months' },
    { value: 'years', label: 'years' },
  ]

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
    onUpdated?: (message: string) => void
  }

  let { account, drive, onClose, onUpdated }: Props = $props()

  type Unit = 'days' | 'months' | 'years'
  type Phase = 'form' | 'pending' | 'error'

  let count = $state('0')
  let unit = $state<Unit>('months')
  let phase = $state<Phase>('form')
  let errorMessage = $state('')
  let currentPrice = $state<bigint | undefined>(undefined)
  let attempt = 0

  const addedSeconds = $derived.by(() => {
    const value = Number(count)
    if (!Number.isFinite(value) || value <= 0) {
      return 0
    }
    const unitSeconds =
      unit === 'years' ? SECONDS_PER_YEAR : unit === 'months' ? SECONDS_PER_MONTH : SECONDS_PER_DAY
    return Math.round(value * unitSeconds)
  })

  const changed = $derived(addedSeconds > 0)
  const estimatedUntil = $derived(
    formatYmd(Date.now() + ((drive.batchTTL ?? 0) + addedSeconds) * 1000),
  )

  const estimateBzz = $derived.by(() => {
    if (!changed || currentPrice === undefined) {
      return undefined
    }
    const days = Math.max(1, Math.ceil(addedSeconds / SECONDS_PER_DAY))
    const amount = calculateStampAmountForDays(currentPrice, days)
    if (amount <= 0n) {
      return undefined
    }
    try {
      return Utils.getStampCost(drive.depth, amount).toSignificantDigits(COST_SIGNIFICANT_DIGITS)
    } catch {
      return undefined
    }
  })

  const infoText = $derived(
    !changed
      ? 'No changes made yet.'
      : estimateBzz
        ? `Estimated cost ≈ ${estimateBzz} BZZ`
        : 'Final cost is shown at payment.',
  )

  $effect(() => {
    fetchChainState(DEFAULT_BEE_NODE_URL)
      .then((state) => (currentPrice = state.currentPrice))
      .catch(() => undefined)
  })

  function step(delta: number) {
    count = String(Math.max(0, (Number(count) || 0) + delta))
  }

  function close() {
    attempt++
    onClose()
  }

  async function proceed() {
    if (!changed) {
      return
    }
    if (currentPrice === undefined) {
      errorMessage = 'Couldn’t fetch the current price. Check your connection and try again.'
      phase = 'error'
      return
    }
    const myAttempt = ++attempt
    phase = 'pending'
    errorMessage = ''
    try {
      const days = Math.max(1, Math.ceil(addedSeconds / SECONDS_PER_DAY))
      const topUpAmount = calculateStampAmountForDays(currentPrice, days)
      await topUpStamp(drive.batchID.toHex(), topUpAmount)
      if (myAttempt !== attempt) {
        return
      }
      account.updateStamp(drive.batchID, extendedStamp(drive, addedSeconds, topUpAmount))
      onUpdated?.('Lifespan extended')
      close()
    } catch (caught) {
      if (myAttempt !== attempt) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not extend the lifespan.'
      phase = 'error'
    }
  }
</script>

{#if phase === 'pending'}
  <Dialog onclose={close} dismissable={false} title={drive.name || 'Drive'}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm">Extending the lifespan…</p>
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
        <Select options={UNIT_OPTIONS} bind:value={unit} class="w-32" />
      </div>
      <p class="text-muted-foreground text-sm">Estimated until {estimatedUntil}</p>
    </div>

    <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">{infoText}</p>

    <Button class="w-full" disabled={!changed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
