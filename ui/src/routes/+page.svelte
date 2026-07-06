<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import UserRoundMinus from '@lucide/svelte/icons/user-round-minus'
  import UserRoundPlus from '@lucide/svelte/icons/user-round-plus'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AccountList from '$lib/components/account-list.svelte'
  import SettingsMenu from '$lib/components/settings-menu.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'
  import { notImplemented } from '$lib/utils'

  /** Shows the create/import choice while other accounts exist on the device. */
  let addingAccount = $state(false)

  const accounts = $derived(accountsStore.accounts)

  async function select(account: Account) {
    sessionStore.setCurrentAccount(account.id)
    await goto(resolve(routes.HOME))
  }
</script>

<div class="relative flex min-h-svh flex-col items-center justify-center p-8">
  <div class="absolute top-8 right-8">
    <SettingsMenu />
  </div>

  <div class="flex w-full max-w-96 flex-col items-center gap-8">
    {#if addingAccount && accounts.length > 0}
      <Button
        variant="outline"
        size="icon"
        aria-label="Back to your accounts"
        class="size-6 self-start rounded-md [&_svg]:size-3"
        onclick={() => (addingAccount = false)}
      >
        <ChevronLeft />
      </Button>
    {/if}

    <SwarmWordmark height={36} />

    {#if accounts.length > 0 && !addingAccount}
      <div class="flex w-full flex-col gap-2">
        <AccountList {accounts} onselect={select} />

        <Button variant="outline" size="sm" class="w-full" onclick={notImplemented}>
          <UserRoundMinus />
          Remove an account
        </Button>
        <Button variant="outline" size="sm" class="w-full" onclick={() => (addingAccount = true)}>
          <UserRoundPlus />
          Add an account
        </Button>
      </div>
    {:else}
      <div class="flex w-full flex-col items-center gap-4">
        <Button size="lg" class="w-full" href={resolve(routes.ACCOUNT_NEW)}>
          Create a new account
        </Button>
        <Button size="lg" variant="secondary" class="w-full" href={resolve(routes.ACCOUNT_IMPORT)}>
          I already have an account
        </Button>
      </div>
    {/if}
  </div>
</div>
