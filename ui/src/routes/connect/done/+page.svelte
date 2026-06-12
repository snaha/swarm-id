<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import CircleCheck from '@lucide/svelte/icons/circle-check'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  const IDENTICON_SIZE = 80

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )
  const request = connectStore.request

  onMount(() => {
    if (!account || !request) {
      goto(resolve(routes.ROOT))
    }
  })

  function continueToApp() {
    connectStore.clear()
    window.close()
  }
</script>

<div class="flex min-h-svh flex-col">
  <AppHeader />

  {#if account && request}
    <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
      <div class="flex w-full max-w-96 flex-col items-center gap-8">
        <div class="flex flex-col items-center gap-4">
          <Polycon
            value={account.id}
            size={IDENTICON_SIZE}
            class="shrink-0 overflow-hidden rounded-lg"
          />
          <p class="text-sm font-bold">{account.name}</p>
        </div>

        <div class="flex flex-col items-center gap-2 text-center">
          <CircleCheck class="size-5" />
          <p class="text-sm font-bold">All set!</p>
          <p class="text-sm">Your account is connected to {request.appName}.</p>
        </div>

        <Button class="w-full" onclick={continueToApp}>Continue to app</Button>
      </div>
    </main>
  {/if}
</div>
