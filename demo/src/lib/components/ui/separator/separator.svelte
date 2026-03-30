<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { cn } from '$lib/utils'
  import type { HTMLAttributes } from 'svelte/elements'

  interface Props extends HTMLAttributes<HTMLDivElement> {
    orientation?: 'horizontal' | 'vertical'
    class?: string
  }

  let { orientation = 'horizontal', class: className, ...restProps }: Props = $props()
</script>

<div
  role="none"
  class={cn(
    'shrink-0 bg-border',
    orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
    className,
  )}
  {...restProps}
></div>
