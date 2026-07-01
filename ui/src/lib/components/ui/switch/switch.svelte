<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { cn } from '$lib/utils'

  interface Props {
    checked: boolean
    class?: string
    'aria-label'?: string
  }

  let { checked = $bindable(), class: className, ...restProps }: Props = $props()
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  data-slot="switch"
  onclick={() => (checked = !checked)}
  class={cn(
    'focus-visible:ring-ring/50 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-3',
    checked ? 'bg-primary' : 'bg-input',
    className,
  )}
  {...restProps}
>
  <span
    class={cn(
      'bg-background pointer-events-none block size-4 rounded-full shadow-sm transition-transform',
      checked ? 'translate-x-4' : 'translate-x-0.5',
    )}
  ></span>
</button>
