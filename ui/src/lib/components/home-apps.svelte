<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Unlink from '@lucide/svelte/icons/unlink'

  import AppIcon from '$lib/components/app-icon.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Select } from '$lib/components/ui/select'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import type { Account } from '$lib/types'

  const DEFAULT_CONNECTION_DAYS = 30
  const DURATION_OPTIONS = [
    { value: '1', label: '1 day' },
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
  ]
  const MENU_ITEM_CLASS =
    'flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted'

  interface Props {
    account: Account
  }

  let { account }: Props = $props()

  let connectionDays = $derived(String(account.appConnectionDays ?? DEFAULT_CONNECTION_DAYS))
  let openMenuFor = $state<string | undefined>(undefined)

  function isConnected(connectedUntil: number | undefined): boolean {
    return connectedUntil !== undefined && connectedUntil > Date.now()
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (openMenuFor && !(event.target as HTMLElement).closest('[data-app-menu]')) {
      openMenuFor = undefined
    }
  }

  function disconnect(appUrl: string) {
    accountsStore.disconnectApp(account.id, appUrl)
    openMenuFor = undefined
  }

  function remove(appUrl: string) {
    accountsStore.removeApp(account.id, appUrl)
    openMenuFor = undefined
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="flex w-full flex-col gap-4">
  <div class="flex w-full items-center justify-between gap-4">
    <p class="text-sm">Keep apps connected for</p>
    <Select
      options={DURATION_OPTIONS}
      bind:value={connectionDays}
      class="w-52"
      onchange={(value) => accountsStore.setAppConnectionDays(account.id, Number(value))}
    />
  </div>

  <div class="bg-border h-px w-full"></div>

  {#if account.connectedApps.length === 0}
    <p class="text-muted-foreground py-8 text-center text-sm">No connected apps yet.</p>
  {:else}
    <div class="flex w-full flex-col">
      {#each account.connectedApps as app (app.appUrl)}
        <div class="border-border flex w-full items-center gap-3 border-b py-2.5">
          <AppIcon src={app.appIcon} name={app.appName} size={32} />
          <div class="flex min-w-0 flex-1 flex-col">
            <p class="truncate text-sm font-medium">{app.appName}</p>
            <p class="text-muted-foreground truncate text-sm">{app.appUrl}</p>
          </div>
          {#if isConnected(app.connectedUntil)}
            <span class="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
              Connected
            </span>
          {/if}
          <div class="relative" data-app-menu>
            <Button
              variant="ghost"
              size="icon"
              aria-label="App actions"
              aria-haspopup="menu"
              aria-expanded={openMenuFor === app.appUrl}
              onclick={() => (openMenuFor = openMenuFor === app.appUrl ? undefined : app.appUrl)}
            >
              <EllipsisVertical />
            </Button>
            {#if openMenuFor === app.appUrl}
              <div
                role="menu"
                tabindex="-1"
                class="bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-1 min-w-36 rounded-lg border p-1 shadow-md"
              >
                {#if isConnected(app.connectedUntil)}
                  <button
                    type="button"
                    role="menuitem"
                    class={MENU_ITEM_CLASS}
                    onclick={() => disconnect(app.appUrl)}
                  >
                    <Unlink class="size-4 shrink-0" />
                    <span class="flex-1 whitespace-nowrap">Disconnect</span>
                  </button>
                {/if}
                <button
                  type="button"
                  role="menuitem"
                  class={MENU_ITEM_CLASS}
                  onclick={() => remove(app.appUrl)}
                >
                  <Trash2 class="size-4 shrink-0" />
                  <span class="flex-1 whitespace-nowrap">Remove</span>
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
