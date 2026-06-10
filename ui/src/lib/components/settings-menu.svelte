<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Contrast from '@lucide/svelte/icons/contrast'
  import History from '@lucide/svelte/icons/history'
  import Menu from '@lucide/svelte/icons/menu'
  import Moon from '@lucide/svelte/icons/moon'
  import Settings from '@lucide/svelte/icons/settings'
  import Sun from '@lucide/svelte/icons/sun'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import { Button } from '$lib/components/ui/button'
  import { type ThemePreference, themeStore } from '$lib/stores/theme.svelte'

  const APPEARANCE_OPTIONS = [
    { value: 'auto', label: 'Automatic', icon: Contrast },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ] as const

  const ITEM_CLASS =
    'flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted'

  let open = $state(false)
  let container = $state<HTMLDivElement>()

  function close() {
    open = false
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (open && container && !container.contains(event.target as Node)) {
      close()
    }
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      close()
    }
  }

  function restoreFromBackup() {
    close()
    goto(resolve('/account/restore'))
  }

  function selectAppearance(value: ThemePreference) {
    themeStore.set(value)
    close()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div bind:this={container} class="relative">
  <Button
    variant="ghost"
    size="icon"
    aria-label="Menu"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Menu />
  </Button>

  {#if open}
    <div
      role="menu"
      tabindex="-1"
      class="bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-2 min-w-36 rounded-lg border p-1 shadow-md"
    >
      <button type="button" role="menuitem" class={ITEM_CLASS} onclick={close}>
        <Settings class="size-4 shrink-0" />
        <span class="flex-1 whitespace-nowrap">Network settings</span>
      </button>
      <button type="button" role="menuitem" class={ITEM_CLASS} onclick={restoreFromBackup}>
        <History class="size-4 shrink-0" />
        <span class="flex-1 whitespace-nowrap">Restore account from backup</span>
      </button>

      <div class="bg-border -mx-1 my-1 h-px"></div>

      <div class="text-muted-foreground px-1.5 py-1 text-xs">Appearance</div>
      {#each APPEARANCE_OPTIONS as option (option.value)}
        {@const Icon = option.icon}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={themeStore.preference === option.value}
          class={ITEM_CLASS}
          onclick={() => selectAppearance(option.value)}
        >
          <Icon class="size-4 shrink-0" />
          <span class="flex-1 whitespace-nowrap">{option.label}</span>
          {#if themeStore.preference === option.value}
            <Check class="size-4 shrink-0" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
