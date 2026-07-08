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
  import AccountSwitcher from '$lib/components/account-switcher.svelte'
  import HomeAccount from '$lib/components/home-account.svelte'
  import HomeApps from '$lib/components/home-apps.svelte'
  import HomeDrives from '$lib/components/home-drives.svelte'
  import SettingsMenu from '$lib/components/settings-menu.svelte'
  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Tabs } from '$lib/components/ui/tabs'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'
  import { notImplemented } from '$lib/utils'

  const TABS = [
    { value: 'apps', label: 'Apps' },
    { value: 'drives', label: 'Storage' },
    { value: 'account', label: 'Account' },
  ]

  /** Shows the create/import choice while other accounts exist on the device. */
  let addingAccount = $state(false)
  let tab = $state('apps')

  const accounts = $derived(accountsStore.accounts)
  // The active session's account, if any: with one the page IS the app
  // (apps/drives/account tabs); without one it is the account chooser. A
  // signed-out current account (sign-out in another tab arrives via the
  // storage listener) has no keys left, so there is no session to show.
  const account = $derived.by(() => {
    const current = sessionStore.currentAccountId
      ? accountsStore.get(sessionStore.currentAccountId)
      : undefined
    return current?.isSignedOut ? undefined : current
  })

  function select(chosen: Account) {
    if (chosen.isSignedOut) {
      // No keys on this device — signing back in means importing the phrase.
      void goto(resolve(routes.ACCOUNT_IMPORT))
      return
    }
    sessionStore.setCurrentAccount(chosen.id)
  }

  function signedOutBadge(candidate: Account): string | undefined {
    return candidate.isSignedOut ? 'Signed out' : undefined
  }
</script>

{#if account}
  <div class="flex min-h-svh flex-col">
    <header class="flex w-full items-center gap-2 p-8">
      <SwarmWordmark height={30} />
      <div class="flex flex-1 items-center justify-end gap-2">
        <AccountSwitcher {account} onmanage={() => (tab = 'account')} />
        <SettingsMenu />
      </div>
    </header>

    <main class="flex w-full flex-1 flex-col items-center px-8 pb-8">
      <div class="flex w-full max-w-144 flex-col items-center gap-8">
        <Tabs tabs={TABS} bind:value={tab} />

        <!-- Keyed so per-account state (e.g. the unlocked seed) never survives a switch. -->
        {#key account.id}
          {#if tab === 'apps'}
            <HomeApps {account} />
          {:else if tab === 'drives'}
            <HomeDrives {account} />
          {:else}
            <HomeAccount {account} />
          {/if}
        {/key}
      </div>
    </main>
  </div>
{:else}
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
          <AccountList {accounts} badge={signedOutBadge} onselect={select} />

          <Button variant="outline" size="sm" class="w-full" onclick={notImplemented}>
            <UserRoundMinus />
            Remove an account
          </Button>
          <Button variant="outline" size="sm" class="w-full" onclick={() => (addingAccount = true)}>
            <UserRoundPlus />
            Sign in to another account
          </Button>
        </div>
      {:else}
        <div class="flex w-full flex-col items-center gap-4">
          <Button size="lg" class="w-full" href={resolve(routes.ACCOUNT_NEW)}>
            Create a new account
          </Button>
          <Button
            size="lg"
            variant="secondary"
            class="w-full"
            href={resolve(routes.ACCOUNT_IMPORT)}
          >
            I already have an account
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/if}
