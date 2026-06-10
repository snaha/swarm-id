<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import Polycon from '$lib/components/polycon.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Tabs } from '$lib/components/ui/tabs'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  const IDENTICON_SIZE = 32
  const TABS = [
    { value: 'apps', label: 'Apps' },
    { value: 'stamps', label: 'Stamps' },
    { value: 'account', label: 'Account' },
  ]

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )

  let tab = $state('apps')

  onMount(() => {
    if (!account) {
      goto(resolve('/'))
    }
  })
</script>

<div class="flex min-h-svh flex-col">
  <header class="flex w-full items-center gap-2 p-8">
    <SwarmWordmark height={30} />
    {#if account}
      <div class="flex flex-1 items-center justify-end gap-2">
        <span class="text-sm font-medium">{account.name}</span>
        <Polycon
          value={account.id}
          size={IDENTICON_SIZE}
          class="shrink-0 overflow-hidden rounded-lg"
        />
      </div>
    {/if}
  </header>

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-108 flex-col items-center gap-8">
      <Tabs tabs={TABS} bind:value={tab} />
      <!-- Apps / Stamps / Account management screens land here next. -->
    </div>
  </main>
</div>
