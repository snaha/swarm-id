<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import type { Snippet } from 'svelte'

  import X from '@lucide/svelte/icons/x'

  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'

  interface Props {
    /** Omitted for pending states which render their own centered content. */
    title?: string
    /** Hide the X button while an operation is pending. */
    dismissable?: boolean
    onclose: () => void
    class?: string
    children: Snippet
  }

  let { title, dismissable = true, onclose, class: className, children }: Props = $props()

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && dismissable) {
      onclose()
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="bg-background/60 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
  <div
    role="dialog"
    aria-modal="true"
    aria-label={title}
    class={cn(
      'bg-popover flex w-96 max-w-[calc(100vw-4rem)] flex-col gap-4 rounded-lg border p-4 shadow-lg',
      className,
    )}
  >
    {#if title !== undefined}
      <div class="flex items-start justify-between gap-2">
        <p class="text-sm font-bold">{title}</p>
        {#if dismissable}
          <Button
            variant="ghost"
            size="icon"
            class="-mt-1.5 -mr-1.5 size-6 rounded-md [&_svg]:size-3.5"
            aria-label="Close"
            onclick={onclose}
          >
            <X />
          </Button>
        {/if}
      </div>
    {/if}

    {@render children()}
  </div>
</div>
