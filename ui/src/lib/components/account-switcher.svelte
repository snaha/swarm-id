<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

  import Polycon from '$lib/components/polycon.svelte'
  import { Button } from '$lib/components/ui/button'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'

  const ITEM_CLASS =
    'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted'

  interface Props {
    account: Account
  }

  let { account }: Props = $props()

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

  function switchTo(id: string) {
    sessionStore.setCurrentAccount(id)
    close()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div bind:this={container} class="relative">
  <Button
    variant="ghost"
    class="h-10 gap-2 px-2"
    aria-label="Switch account"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span class="text-sm font-medium">{account.name}</span>
    <Polycon value={account.id} size={32} class="shrink-0 overflow-hidden rounded-lg" />
    <ChevronDown class="text-muted-foreground size-4" />
  </Button>

  {#if open}
    <div
      role="menu"
      tabindex="-1"
      class="bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-2 min-w-56 rounded-lg border p-1 shadow-md"
    >
      <div class="text-muted-foreground px-1.5 py-1 text-xs">Account</div>
      {#each accountsStore.accounts as candidate (candidate.id)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={candidate.id === account.id}
          class={ITEM_CLASS}
          onclick={() => switchTo(candidate.id)}
        >
          <Polycon value={candidate.id} size={24} class="shrink-0 overflow-hidden rounded-md" />
          <span class="flex-1 truncate whitespace-nowrap">{candidate.name}</span>
          {#if candidate.id === account.id}
            <Check class="size-4 shrink-0" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
