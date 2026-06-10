<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check'

  interface Props {
    message?: string
  }

  let { message }: Props = $props()
</script>

{#if message}
  <div
    role="status"
    class="bg-popover text-popover-foreground fixed bottom-8 left-1/2 z-50 flex w-84 max-w-[calc(100vw-4rem)] -translate-x-1/2 items-center gap-2 rounded-md border p-4 shadow-lg"
  >
    <CircleCheck class="size-5 shrink-0" />
    <p class="text-sm">{message}</p>
  </div>
{/if}
