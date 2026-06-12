<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts" module>
  export interface TabItem {
    value: string
    label: string
  }
</script>

<script lang="ts">
  import { cn } from '$lib/utils'

  interface Props {
    tabs: TabItem[]
    value: string
    class?: string
  }

  let { tabs, value = $bindable(), class: className }: Props = $props()
</script>

<div
  role="tablist"
  class={cn('bg-muted flex h-8 w-full items-center rounded-lg p-[3px]', className)}
>
  {#each tabs as tab (tab.value)}
    <button
      type="button"
      role="tab"
      aria-selected={value === tab.value}
      class={cn(
        'h-full flex-1 cursor-pointer rounded-md border border-transparent px-1.5 text-sm font-medium transition-colors',
        value === tab.value
          ? 'bg-background border-border text-foreground shadow-sm'
          : 'text-muted-foreground',
      )}
      onclick={() => (value = tab.value)}
    >
      {tab.label}
    </button>
  {/each}
</div>
