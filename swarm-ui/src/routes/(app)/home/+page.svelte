<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import CreateAccountButton from '$lib/components/create-account-button.svelte'
  import AccountList from '$lib/components/account-list.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import type { Account } from '$lib/types'
  import routes from '$lib/routes'

  const accounts = $derived(accountsStore.accounts)
  const hasAccounts = $derived(accounts.length > 0)

  // Redirect to product page if no accounts
  $effect(() => {
    if (!hasAccounts) {
      goto(resolve(routes.ROOT))
    }
  })

  function handleAccountClick(account: Account) {
    goto(resolve(routes.ACCOUNT_APPS, { id: account.id.toHex() }))
  }
</script>

{#if hasAccounts}
  <Vertical>
    <Typography variant="h4">Welcome to Swarm ID</Typography>
    <Typography variant="small">Choose an account to continue</Typography>
    <Vertical --vertical-gap="var(--double-padding)">
      <AccountList {accounts} onAccountClick={handleAccountClick} />
      <Horizontal --horizontal-justify-content="flex-start">
        <CreateAccountButton />
      </Horizontal>
    </Vertical>
  </Vertical>
{/if}
