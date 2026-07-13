<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Check from '@lucide/svelte/icons/check'
  import Contrast from '@lucide/svelte/icons/contrast'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Globe from '@lucide/svelte/icons/globe'
  import History from '@lucide/svelte/icons/history'
  import Moon from '@lucide/svelte/icons/moon'
  import Settings from '@lucide/svelte/icons/settings'
  import Sun from '@lucide/svelte/icons/sun'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import NetworkSettingsDialog from '$lib/components/network-settings-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import {
    DropdownMenu,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
  } from '$lib/components/ui/dropdown-menu'
  import routes from '$lib/routes'
  import { themeStore } from '$lib/stores/theme.svelte'

  const APPEARANCE_OPTIONS = [
    { value: 'auto', label: 'Automatic', icon: Contrast },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ] as const

  const PRODUCT_PAGE_URL = 'https://swarm-id.snaha.net'
  const DOCUMENTATION_URL = 'https://swarm.snaha.net/docs'

  let dialogOpen = $state(false)

  function restoreFromBackup() {
    goto(resolve(routes.ACCOUNT_RESTORE))
  }

  function networkSettings() {
    dialogOpen = true
  }
</script>

<DropdownMenu class="top-full right-0 mt-2 min-w-36 p-1">
  {#snippet trigger(props)}
    <Button variant="outline" size="icon" aria-label="Settings" {...props}>
      <Settings />
    </Button>
  {/snippet}

  <DropdownMenuItem onclick={networkSettings}>
    <Settings class="size-4 shrink-0" />
    <span class="flex-1 whitespace-nowrap">Network settings</span>
  </DropdownMenuItem>
  <DropdownMenuItem onclick={restoreFromBackup}>
    <History class="size-4 shrink-0" />
    <span class="flex-1 whitespace-nowrap">Restore account from backup</span>
  </DropdownMenuItem>

  <DropdownMenuSeparator />

  <DropdownMenuItem href={PRODUCT_PAGE_URL} target="_blank" rel="noopener noreferrer">
    <Globe class="size-4 shrink-0" />
    <span class="flex-1 whitespace-nowrap">Product page</span>
    <ExternalLink class="text-muted-foreground size-3.5 shrink-0" />
  </DropdownMenuItem>
  <DropdownMenuItem href={DOCUMENTATION_URL} target="_blank" rel="noopener noreferrer">
    <BookOpen class="size-4 shrink-0" />
    <span class="flex-1 whitespace-nowrap">Documentation</span>
    <ExternalLink class="text-muted-foreground size-3.5 shrink-0" />
  </DropdownMenuItem>

  <DropdownMenuSeparator />

  <DropdownMenuLabel>Appearance</DropdownMenuLabel>
  {#each APPEARANCE_OPTIONS as option (option.value)}
    {@const Icon = option.icon}
    <DropdownMenuItem
      checked={themeStore.preference === option.value}
      onclick={() => themeStore.set(option.value)}
    >
      <Icon class="size-4 shrink-0" />
      <span class="flex-1 whitespace-nowrap">{option.label}</span>
      {#if themeStore.preference === option.value}
        <Check class="size-4 shrink-0" />
      {/if}
    </DropdownMenuItem>
  {/each}
</DropdownMenu>

{#if dialogOpen}
  <NetworkSettingsDialog onclose={() => (dialogOpen = false)} />
{/if}
