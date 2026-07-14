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

  const buttons: (HTMLButtonElement | undefined)[] = []

  // Roving tabindex: the selected tab is the tablist's only Tab stop (falling
  // back to the first tab should `value` match none).
  const tabStop = $derived(
    Math.max(
      0,
      tabs.findIndex((tab) => tab.value === value),
    ),
  )

  // WAI-ARIA tabs keyboard contract with automatic activation: arrows move
  // focus and selection together, wrapping at the ends.
  function onKeydown(event: KeyboardEvent, index: number) {
    let target: number
    switch (event.key) {
      case 'ArrowLeft':
        target = (index - 1 + tabs.length) % tabs.length
        break
      case 'ArrowRight':
        target = (index + 1) % tabs.length
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    value = tabs[target].value
    buttons[target]?.focus()
  }
</script>

<div
  role="tablist"
  class={cn('bg-muted flex h-8 w-full items-center rounded-lg p-[3px]', className)}
>
  {#each tabs as tab, index (tab.value)}
    <button
      bind:this={buttons[index]}
      type="button"
      role="tab"
      aria-selected={value === tab.value}
      tabindex={index === tabStop ? 0 : -1}
      class={cn(
        'h-full flex-1 cursor-pointer rounded-md border border-transparent px-1.5 text-sm font-medium transition-colors',
        value === tab.value
          ? 'bg-background border-border text-foreground shadow-sm'
          : 'text-muted-foreground',
      )}
      onclick={() => (value = tab.value)}
      onkeydown={(event) => onKeydown(event, index)}
    >
      {tab.label}
    </button>
  {/each}
</div>
