<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '$lib/utils'
  import type { HTMLSelectAttributes } from 'svelte/elements'

  interface Props extends HTMLSelectAttributes {
    class?: string
    value?: string
    children: Snippet
  }

  let { class: className, value = $bindable(''), children, ...restProps }: Props = $props()
</script>

<select
  class={cn(
    'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  bind:value
  {...restProps}
>
  {@render children()}
</select>
