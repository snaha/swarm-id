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
  import { DropdownMenu, DropdownMenuItem } from '$lib/components/ui/dropdown-menu'
  import { Select } from '$lib/components/ui/select'
  import { msToDays } from '$lib/duration'
  import type { Account } from '$lib/types'

  const DEFAULT_CONNECTION_DAYS = 30
  const DURATION_OPTIONS = [
    { value: '1', label: '1 day' },
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
  ]

  interface Props {
    account: Account
  }

  let { account }: Props = $props()

  let connectionDays = $derived(
    String(
      account.settings?.appSessionDuration !== undefined
        ? msToDays(account.settings.appSessionDuration)
        : DEFAULT_CONNECTION_DAYS,
    ),
  )
  // Revoked tombstones stay in the record for sync; only show live entries.
  const activeApps = $derived(account.activeApps)

  function isConnected(connectedUntil: number | undefined): boolean {
    return connectedUntil !== undefined && connectedUntil > Date.now()
  }

  function disconnect(appUrl: string) {
    // Drops the app secret the dApp's proxy iframe authenticates from.
    account.disconnectApp(appUrl)
  }

  function remove(appUrl: string) {
    account.removeApp(appUrl)
  }
</script>

<div class="flex w-full flex-col gap-4">
  <div class="flex w-full items-center justify-between gap-4">
    <p class="text-sm">Keep apps connected for</p>
    <Select
      options={DURATION_OPTIONS}
      bind:value={connectionDays}
      class="w-70"
      onchange={(value) => account.setAppConnectionDays(Number(value))}
    />
  </div>

  <div class="bg-border h-px w-full"></div>

  {#if activeApps.length === 0}
    <p class="text-muted-foreground py-8 text-center text-sm">No connected apps yet.</p>
  {:else}
    <div class="flex w-full flex-col">
      {#each activeApps as app (app.appUrl)}
        <div class="border-border flex w-full items-center gap-3 border-b py-2.5">
          <AppIcon src={app.appIcon} name={app.appName} size={40} />
          <div class="flex min-w-0 flex-1 flex-col">
            <p class="truncate text-sm font-medium">{app.appName}</p>
            <p class="text-muted-foreground truncate text-sm">{app.appUrl}</p>
          </div>
          {#if isConnected(app.connectedUntil)}
            <span class="bg-secondary text-secondary-foreground rounded-md px-2 py-0.5 text-xs">
              Connected
            </span>
          {/if}
          <DropdownMenu class="top-full right-0 mt-1 min-w-36 p-1">
            {#snippet trigger(props)}
              <Button variant="ghost" size="icon" aria-label="App actions" {...props}>
                <EllipsisVertical />
              </Button>
            {/snippet}

            {#if isConnected(app.connectedUntil)}
              <DropdownMenuItem onclick={() => disconnect(app.appUrl)}>
                <Unlink class="size-4 shrink-0" />
                <span class="flex-1 whitespace-nowrap">Disconnect</span>
              </DropdownMenuItem>
            {/if}
            <DropdownMenuItem onclick={() => remove(app.appUrl)}>
              <Trash2 class="size-4 shrink-0" />
              <span class="flex-1 whitespace-nowrap">Remove</span>
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      {/each}
    </div>
  {/if}
</div>
