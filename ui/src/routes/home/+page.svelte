<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AccountSwitcher from '$lib/components/account-switcher.svelte'
  import HomeAccount from '$lib/components/home-account.svelte'
  import HomeApps from '$lib/components/home-apps.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Tabs } from '$lib/components/ui/tabs'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  const TABS = [
    { value: 'apps', label: 'Apps' },
    { value: 'drives', label: 'Drives' },
    { value: 'account', label: 'Account' },
  ]

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )

  let tab = $state('apps')

  onMount(() => {
    if (!account) {
      goto(resolve(routes.ROOT))
    }
  })
</script>

<div class="flex min-h-svh flex-col">
  <header class="flex w-full items-center gap-2 p-8">
    <SwarmWordmark height={30} />
    {#if account}
      <div class="flex flex-1 items-center justify-end">
        <AccountSwitcher {account} />
      </div>
    {/if}
  </header>

  <main class="flex w-full flex-1 flex-col items-center px-8 pb-8">
    <div class="flex w-full max-w-144 flex-col items-center gap-8">
      <Tabs tabs={TABS} bind:value={tab} />

      {#if account}
        <!-- Keyed so per-account state (e.g. the unlocked seed) never survives a switch. -->
        {#key account.id}
          {#if tab === 'apps'}
            <HomeApps {account} />
          {:else if tab === 'drives'}
            <p class="text-muted-foreground py-8 text-center text-sm">
              Drive management is coming soon.
            </p>
          {:else}
            <HomeAccount {account} />
          {/if}
        {/key}
      {/if}
    </div>
  </main>
</div>
