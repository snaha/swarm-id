<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import Toast from '$lib/components/toast.svelte'
  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  const TOAST_DURATION_MS = 4000
  const IDENTICON_SIZE = 80

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )
  const restored = sessionStore.completedFlow === 'restore'

  let toastMessage = $state<string | undefined>(undefined)

  onMount(() => {
    if (!account) {
      goto(resolve(routes.ROOT))
      return
    }
    toastMessage = restored ? 'Account restored successfully!' : 'Sign in successful'
    const timer = setTimeout(() => (toastMessage = undefined), TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  })
</script>

<div class="flex min-h-svh flex-col">
  <AppHeader />

  {#if account}
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

        <div class="flex w-full flex-col items-center gap-2">
          <Button class="w-full" href={resolve(routes.HOME)}>Continue with this account</Button>
          {#if restored}
            <Button variant="outline" class="w-full" href={resolve(routes.ACCOUNT_RESTORE)}>
              Restore another account
            </Button>
          {:else}
            <Button variant="outline" class="w-full" href={resolve(routes.ACCOUNT_IMPORT)}>
              Sign in to another account
            </Button>
          {/if}
        </div>
      </div>
    </main>
  {/if}

  <Toast message={toastMessage} />
</div>
