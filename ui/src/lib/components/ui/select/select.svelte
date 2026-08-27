<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts" module>
  export interface SelectOption {
    value: string
    label: string
    /** Listed but unchoosable — an option whose own precondition failed, kept
     * visible so the list does not silently lose an entry the user saw. */
    disabled?: boolean
  }
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

  import { cn } from '$lib/utils'

  interface Props {
    options: SelectOption[]
    value: string
    class?: string
    disabled?: boolean
    onchange?: (value: string) => void
  }

  let {
    options,
    value = $bindable(),
    class: className,
    disabled = false,
    onchange,
  }: Props = $props()
</script>

<div class={cn('relative', className)}>
  <select
    bind:value
    {disabled}
    onchange={() => onchange?.(value)}
    class="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full cursor-pointer appearance-none rounded-lg border py-1 pr-8 pl-2.5 text-sm transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
  >
    {#each options as option (option.value)}
      <option value={option.value} disabled={option.disabled}>{option.label}</option>
    {/each}
  </select>
  <ChevronDown
    class="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2"
  />
</div>
