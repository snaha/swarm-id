<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import UserRoundMinus from '@lucide/svelte/icons/user-round-minus'
  import UserRoundPlus from '@lucide/svelte/icons/user-round-plus'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { completeConnect, hasReusableConnection, reuseConnection } from '$lib/connect-handshake'
  import { unlockAccount } from '$lib/crypto/unlock'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'
  import { notImplemented, truncateAddress } from '$lib/utils'

  let missingRequest = $state(false)
  let unlocking = $state<Account | undefined>(undefined)
  let pendingCeremony = $state(false)
  let busy = $state(false)
  let password = $state('')
  let dialogError = $state<string | undefined>(undefined)
  /** Bumped on cancel/retry — a stale ceremony resolution must not connect. */
  let attempt = 0
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
   * Previously connected to this app but the session lapsed (expired or
   * revoked) — connecting again will ask for an unlock.
   */
  function signedOut(account: Account): boolean {
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
    // A still-valid prior connection carries the secret — no unlock needed.
    if (reuseConnection(account, request)) {
      sessionStore.setCurrentAccount(account.id)
      await goto(resolve(routes.CONNECT_DONE))
      return
    }
    dialogError = undefined
    password = ''
    pendingCeremony = false
    unlocking = account
  }

  function startAdding() {
    addingAccount = true
  }

  async function confirmUnlock() {
    const account = unlocking
    if (busy || !account || !request) {
      return
    }
    const myAttempt = ++attempt
    dialogError = undefined
    busy = true
    if (account.access.type !== 'password') {
      pendingCeremony = true
    }
    try {
      const entropy = await unlockAccount(
        account,
        account.access.type === 'password' ? password : undefined,
      )
      if (myAttempt !== attempt) {
        return
      }
      await completeConnect(account, entropy, request)
      sessionStore.setCurrentAccount(account.id)
      unlocking = undefined
      password = ''
      await goto(resolve(routes.CONNECT_DONE))
    } catch (caught) {
      if (myAttempt === attempt) {
        dialogError = caught instanceof Error ? caught.message : 'Unlock failed.'
        pendingCeremony = false
      }
    } finally {
      if (myAttempt === attempt) {
        busy = false
      }
    }
  }

  function closeDialog() {
    // Invalidate any in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not connect.
    attempt++
    unlocking = undefined
    pendingCeremony = false
    busy = false
    password = ''
    dialogError = undefined
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
            {#each sortedAccounts as account (account.id.toHex())}
              <button
                type="button"
                class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-lg border p-2 text-left outline-none"
                onclick={() => select(account)}
              >
                <Polycon
                  value={account.id.toHex()}
                  size={36}
                  class="shrink-0 overflow-hidden rounded-md"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-sm font-medium">{account.name}</span>
                  <span class="text-muted-foreground text-xs">
                    {truncateAddress(account.id.toChecksum())}
                  </span>
                </span>
                {#if signedOut(account)}
                  <Badge>Signed out</Badge>
                {/if}
              </button>
            {/each}

            <Button variant="outline" size="sm" class="w-full" onclick={notImplemented}>
              <UserRoundMinus />
              Remove an account
            </Button>
            <Button variant="outline" size="sm" class="w-full" onclick={startAdding}>
              <UserRoundPlus />
              Add an account
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
  {#if pendingCeremony}
    <Dialog onclose={closeDialog} dismissable={false}>
      <div class="flex flex-col items-center gap-2 py-4 text-center">
        <LoaderCircle class="size-5 animate-spin" />
        <p class="text-sm font-bold">
          {unlocking.access.type === 'eth-wallet' ? 'Confirm with wallet' : 'Confirm with passkey'}
        </p>
        <p class="text-sm">
          {unlocking.access.type === 'eth-wallet'
            ? 'Approve the request in your Ethereum wallet.'
            : 'Follow the prompts on your device.'}
        </p>
      </div>
      <Button variant="outline" class="w-full" onclick={closeDialog}>Cancel</Button>
    </Dialog>
  {:else}
    <Dialog onclose={closeDialog} title="Connect as {unlocking.name}">
      <p class="text-sm">
        Unlock your account to approve the connection to {request?.appName}.
      </p>

      {#if unlocking.access.type === 'password'}
        <Input
          type="password"
          bind:value={password}
          placeholder="Account password"
          autocomplete="current-password"
          onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirmUnlock()}
        />
      {/if}

      {#if dialogError}
        <p class="text-destructive text-xs">{dialogError}</p>
      {/if}

      <Button
        class="w-full"
        disabled={busy || (unlocking.access.type === 'password' && password.length === 0)}
        onclick={confirmUnlock}
      >
        {#if busy}
          <LoaderCircle class="animate-spin" />
        {/if}
        {unlocking.access.type === 'passkey'
          ? 'Confirm with passkey'
          : unlocking.access.type === 'eth-wallet'
            ? 'Confirm with wallet'
            : 'Confirm'}
      </Button>
    </Dialog>
  {/if}
{/if}
