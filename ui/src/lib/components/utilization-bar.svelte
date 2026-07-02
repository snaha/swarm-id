<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { cn } from '$lib/utils'

  const PERCENT_MAX = 100

  interface Props {
    /** Filled portion, 0–100. */
    percent: number
    /** Paint the fill in the destructive colour (e.g. a full drive). */
    destructive?: boolean
    /** Sizing utilities for the track (width/height); defaults to a mini bar. */
    class?: string
    /** Accessible name for the progressbar. */
    label?: string
  }

  let { percent, destructive = false, class: className, label = 'Storage used' }: Props = $props()

  const clamped = $derived(Math.min(PERCENT_MAX, Math.max(0, percent)))
</script>

<div
  class={cn('bg-muted h-1.5 w-16 overflow-hidden rounded-full', className)}
  role="progressbar"
  aria-label={label}
  aria-valuenow={clamped}
  aria-valuemin={0}
  aria-valuemax={PERCENT_MAX}
>
  <div
    class={cn('h-full rounded-full', destructive ? 'bg-destructive' : 'bg-foreground')}
    style="width: {clamped}%"
  ></div>
</div>
