<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import UserRoundMinus from '@lucide/svelte/icons/user-round-minus'
  import UserRoundPlus from '@lucide/svelte/icons/user-round-plus'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AccountList from '$lib/components/account-list.svelte'
  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import { Button } from '$lib/components/ui/button'
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import { completeConnect, hasReusableConnection, reuseConnection } from '$lib/connect-handshake'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'
  import { notImplemented } from '$lib/utils'

  let missingRequest = $state(false)
  /** Account being unlocked to approve the connection. */
  let unlocking = $state<Account | undefined>(undefined)
  /** Shows the create/import choice while other accounts exist on the device. */
  let addingAccount = $state(false)

  const request = $derived(connectStore.request)
  const appIcon = $derived(
    request ? (request.appIcon ?? `${request.appOrigin}/favicon.ico`) : undefined,
  )
  const accounts = $derived(accountsStore.accounts)

  // Accounts previously connected to this app first, most recently used on top;
  // the stable sort keeps never-connected accounts in their stored order.
  const sortedAccounts = $derived.by(() => {
    const appOrigin = request?.appOrigin
    if (!appOrigin) {
      return accounts
    }
    const lastConnected = (account: Account) =>
      account.connectedApps.find((app) => app.appUrl === appOrigin)?.lastConnectedAt ?? 0
    return [...accounts].sort((a, b) => lastConnected(b) - lastConnected(a))
  })

  onMount(() => {
    missingRequest = !connectStore.initFromHash(window.location.hash)
  })

  /**
   * Previously connected to this app but the app session lapsed (expired or
   * revoked) — connecting again will ask for an unlock. Distinct from the
   * account being signed out on this device (`account.isSignedOut`).
   */
  function sessionLapsed(account: Account): boolean {
    const appOrigin = request?.appOrigin
    if (!appOrigin) {
      return false
    }
    return (
      account.connectedApps.some((app) => app.appUrl === appOrigin) &&
      !hasReusableConnection(account, appOrigin)
    )
  }

  async function select(account: Account) {
    if (!request) {
      return
    }
    if (account.isSignedOut) {
      // No keys on this device — signing back in means importing the phrase.
      await goto(resolve(routes.ACCOUNT_IMPORT))
      return
    }
    // A still-valid prior connection carries the secret — no unlock needed.
    if (reuseConnection(account, request)) {
      sessionStore.setCurrentAccount(account.id)
      await goto(resolve(routes.CONNECT_DONE))
      return
    }
    unlocking = account
  }

  async function onUnlockedConnect(entropy: Uint8Array) {
    const account = unlocking
    if (!account || !request) {
      return
    }
    await completeConnect(account, entropy, request)
    sessionStore.setCurrentAccount(account.id)
    unlocking = undefined
    await goto(resolve(routes.CONNECT_DONE))
  }

  function startAdding() {
    addingAccount = true
  }
</script>

<div class="flex min-h-svh flex-col">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
    {#if missingRequest}
      <div class="flex w-full max-w-96 flex-col items-center gap-8">
        <div class="flex flex-col items-center gap-2">
          <CircleAlert class="text-destructive size-5" />
          <div class="flex flex-col items-center text-center">
            <p class="text-sm font-bold">Missing connection request</p>
            <p class="text-sm">Open this page from the app you want to connect to Swarm ID.</p>
          </div>
        </div>
      </div>
    {:else if request}
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

        <div class="flex flex-col items-center gap-2">
          <AppIcon src={appIcon} name={request.appName} size={48} />
          <div class="flex flex-col items-center text-center">
            <p class="text-lg font-bold">Connect to {request.appName}</p>
            <p class="text-sm">{request.appOrigin}</p>
          </div>
        </div>

        {#if accounts.length > 0 && !addingAccount}
          <div class="flex w-full flex-col gap-2">
            <AccountList
              accounts={sortedAccounts}
              badge={(account) =>
                account.isSignedOut || sessionLapsed(account) ? 'Signed out' : undefined}
              onselect={select}
            />

            <Button variant="outline" size="sm" class="w-full" onclick={notImplemented}>
              <UserRoundMinus />
              Remove an account
            </Button>
            <Button variant="outline" size="sm" class="w-full" onclick={startAdding}>
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

        <Button variant="ghost" size="xs" onclick={notImplemented}>What is Swarm ID?</Button>
      </div>
    {/if}
  </main>
</div>

{#if unlocking}
  <UnlockDialog
    account={unlocking}
    title="Connect as {unlocking.name}"
    description="Unlock your account to approve the connection to {request?.appName}."
    onunlocked={onUnlockedConnect}
    onclose={() => (unlocking = undefined)}
  />
{/if}
