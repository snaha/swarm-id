<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { cn } from '$lib/utils'

  interface Props {
    /** Filled portion, 0–100. */
    percent: number
    /** Paint the fill in the destructive colour (e.g. a full drive). */
    destructive?: boolean
    /** Sizing utilities for the track (width/height); defaults to a mini bar. */
    class?: string
  }

  let { percent, destructive = false, class: className }: Props = $props()

  const clamped = $derived(Math.min(100, Math.max(0, percent)))
</script>

<div
  class={cn('bg-muted h-1.5 w-16 overflow-hidden rounded-full', className)}
  role="progressbar"
  aria-valuenow={clamped}
  aria-valuemin={0}
  aria-valuemax={100}
>
  <div
    class={cn('h-full rounded-full', destructive ? 'bg-destructive' : 'bg-foreground')}
    style="width: {clamped}%"
  ></div>
</div>
