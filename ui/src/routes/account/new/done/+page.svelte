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
  import { sessionStore } from '$lib/stores/session.svelte'

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )

  onMount(() => {
    if (!account) {
      goto(resolve(routes.ROOT))
    }
  })
</script>

{#if account}
  <AccountDone
    {account}
    toast="Account created successfully!"
    finishLabel="Stay local for now"
    doneMessage="Your Swarm ID is ready."
    onFinish={() => goto(resolve(routes.ROOT))}
  />
{/if}
