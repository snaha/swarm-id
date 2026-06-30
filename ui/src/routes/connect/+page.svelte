<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Tabs } from '$lib/components/ui/tabs'
  import { completeConnect, reuseConnection } from '$lib/connect-handshake'
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

  const request = $derived(connectStore.request)
  const appIcon = $derived(
    request ? (request.appIcon ?? `${request.appOrigin}/favicon.ico`) : undefined,
  )
  const accounts = $derived(accountsStore.accounts)

  // Accounts previously connected to this app, most recently used first.
  const previouslyUsed = $derived.by(() => {
    const appOrigin = request?.appOrigin
    if (!appOrigin) {
      return []
    }
    return accounts
      .map((account) => ({
        account,
        connection: account.connectedApps.find((app) => app.appUrl === appOrigin),
      }))
      .filter((entry) => entry.connection !== undefined)
      .sort((a, b) => (b.connection?.lastConnectedAt ?? 0) - (a.connection?.lastConnectedAt ?? 0))
      .map((entry) => entry.account)
  })

  const TABS = [
    { value: 'previously-used', label: 'Previously used' },
    { value: 'all-accounts', label: 'All accounts' },
  ]

  // Defaults to "Previously used" when available; a user selection takes precedence.
  let selectedTab = $state<string | undefined>(undefined)
  const activeTab = $derived(
    selectedTab ?? (previouslyUsed.length > 0 ? 'previously-used' : 'all-accounts'),
  )
  const shownAccounts = $derived(activeTab === 'previously-used' ? previouslyUsed : accounts)

  onMount(() => {
    missingRequest = !connectStore.initFromHash(window.location.hash)
  })

  async function select(account: Account) {
    if (!request) {
      return
    }
    // A still-valid prior connection carries the secret — no unlock needed.
    if (reuseConnection(account, request)) {
      sessionStore.setCurrentAccount(account.id.toHex())
      await goto(resolve(routes.CONNECT_DONE))
      return
    }
    dialogError = undefined
    password = ''
    pendingCeremony = false
    unlocking = account
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
      sessionStore.setCurrentAccount(account.id.toHex())
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
        <div class="flex flex-col items-center gap-2">
          <AppIcon src={appIcon} name={request.appName} size={48} />
          <div class="flex flex-col items-center text-center">
            <p class="text-lg font-bold">Connect to {request.appName}</p>
            <p class="text-sm">{request.appOrigin}</p>
          </div>
        </div>

        {#if accounts.length > 0}
          <div class="flex w-full flex-col gap-2">
            <p class="text-muted-foreground text-xs">Connect with an account on this device</p>
            {#if previouslyUsed.length > 0}
              <Tabs tabs={TABS} bind:value={() => activeTab, (value) => (selectedTab = value)} />
            {/if}
            <div class="flex w-full flex-col rounded-lg border p-1">
              {#each shownAccounts as account (account.id.toHex())}
                <button
                  type="button"
                  class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-none"
                  onclick={() => select(account)}
                >
                  <Polycon
                    value={account.id.toHex()}
                    size={32}
                    class="shrink-0 overflow-hidden rounded-md"
                  />
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-medium">{account.name}</span>
                    <span class="text-muted-foreground text-xs">
                      {truncateAddress(account.displayId)}
                    </span>
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="flex w-full flex-col items-center gap-4">
          <Button
            size="lg"
            variant={accounts.length > 0 ? 'secondary' : 'default'}
            class="w-full"
            href={resolve(routes.ACCOUNT_NEW)}>Create a new account</Button
          >
          <Button
            size="lg"
            variant="secondary"
            class="w-full"
            href={resolve(routes.ACCOUNT_IMPORT)}
          >
            I already have an account
          </Button>
        </div>

        <Button variant="ghost" size="xs" onclick={notImplemented}>WTF is Swarm ID?</Button>
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
