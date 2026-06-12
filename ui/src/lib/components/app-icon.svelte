<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Globe from '@lucide/svelte/icons/globe'

  interface Props {
    /** Favicon / logo URL for the connecting app. */
    src?: string
    /** App name, used as the image alt text. */
    name: string
    size?: number
  }

  let { src, name, size = 48 }: Props = $props()

  let failed = $state(false)
</script>

<div
  class="bg-muted flex shrink-0 items-center justify-center overflow-hidden rounded-lg"
  style="width: {size}px; height: {size}px;"
>
  {#if src && !failed}
    <img {src} alt={name} class="size-full object-contain" onerror={() => (failed = true)} />
  {:else}
    <Globe class="text-muted-foreground size-6" />
  {/if}
</div>
