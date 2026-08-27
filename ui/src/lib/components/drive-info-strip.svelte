<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  /**
   * The grey strip the drive dialogs show above their primary action. Per the
   * designs it reads as a label on the left with the figure that matters
   * emphasised on the right ("Estimated cost — ~1.59 USD", "Lifespan reduced
   * to — ~2 months"); states with nothing to quantify render the label alone.
   */
  interface Props {
    label: string
    value?: string
  }

  let { label, value }: Props = $props()
</script>

<p class="bg-muted flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-sm">
  <span class={value ? '' : 'text-muted-foreground'}>{label}</span>
  {#if value}
    <span class="font-medium">{value}</span>
  {/if}
</p>
