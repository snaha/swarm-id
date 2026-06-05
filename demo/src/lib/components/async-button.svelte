<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  type Variant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  type Size = 'default' | 'sm' | 'lg' | 'icon'

  interface Props extends Omit<HTMLButtonAttributes, 'onclick'> {
    variant?: Variant
    size?: Size
    class?: string
    /** Async action. The button stays disabled until it settles. */
    onclick?: () => unknown | Promise<unknown>
    /** Label shown while the action is running. */
    loadingText?: string
    children?: Snippet
  }

  let { onclick, loadingText = 'Working…', disabled = false, children, ...rest }: Props = $props()

  let running = $state(false)

  async function run() {
    if (running) return
    running = true
    try {
      await onclick?.()
    } finally {
      running = false
    }
  }
</script>

<Button {...rest} disabled={disabled || running} onclick={run}>
  {#if running}
    {loadingText}
  {:else if children}
    {@render children()}
  {/if}
</Button>
