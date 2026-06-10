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
  import { Alert } from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { notImplemented } from '$lib/utils'

  const TOAST_DURATION_MS = 4000
  const IDENTICON_SIZE = 56

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )

  let toastMessage = $state<string | undefined>('Account created successfully!')

  onMount(() => {
    if (!account) {
      goto(resolve('/'))
      return
    }
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
          <p class="text-lg font-bold">{account.name}</p>
        </div>

        <Alert>
          Your Swarm ID is ready to use. You can browse and view content on this device straight
          away.
        </Alert>

        <div class="flex flex-col items-center text-center">
          <p class="text-sm font-bold">Want the full experience?</p>
          <p class="text-sm">
            Upload data and sync your Swarm ID across devices with a postage stamp.
          </p>
        </div>

        <div class="flex w-full flex-col items-center gap-4">
          <!-- Stamp purchase flow is still TBD in the design. -->
          <Button size="lg" class="w-full" onclick={notImplemented}>Add a postage stamp</Button>
          <Button size="lg" variant="secondary" class="w-full" href={resolve('/home')}>
            Stay local for now
          </Button>
        </div>

        <p class="text-muted-foreground text-center text-xs">
          Local accounts are limited to viewing content and cannot be used on other devices.
        </p>
      </div>
    </main>
  {/if}

  <Toast message={toastMessage} />
</div>
