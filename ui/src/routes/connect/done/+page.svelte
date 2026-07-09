<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AccountDone from '$lib/components/account-done.svelte'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

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

{#if account && request}
  <AccountDone
    {account}
    toast="Connected to {request.appName}!"
    finishLabel="Continue to app"
    doneMessage="Your account is connected to {request.appName}."
    onFinish={continueToApp}
  />
{/if}
