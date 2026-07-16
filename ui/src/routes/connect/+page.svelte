<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AccountList from '$lib/components/account-list.svelte'
  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import UserAddFill from '$lib/components/icons/user-add-fill.svelte'
  import UserUnfollowLine from '$lib/components/icons/user-unfollow-line.svelte'
  import SignBackInDialog, {
    checkStorageDescription,
  } from '$lib/components/sign-back-in-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import { completeConnect, reuseConnection } from '$lib/connect-handshake'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'
  import { notImplemented } from '$lib/utils'

  let missingRequest = $state(false)
  /** Account being unlocked to approve the connection. */
  let unlocking = $state<Account | undefined>(undefined)
  /** Signed-out account being unlocked to check its storage. */
  let checkingStorage = $state<Account | undefined>(undefined)
  /** Shows the create/import choice while other accounts exist on the device. */
  let addingAccount = $state(false)

  const request = $derived(connectStore.request)
  const appIcon = $derived(
    request ? (request.appIcon ?? `${request.appOrigin}/favicon.ico`) : undefined,
  )
  const accounts = $derived(accountsStore.accounts)

  // Accounts that have used this app before, most recently used first. A
  // lapsed session still counts as "previously used" — it is NOT the account
  // being signed out (#445), so these rows carry no badge; the section title
  // says it. `activeApps` (not the raw collection): a REMOVED app leaves a
  // revoked tombstone behind for sync, which must not resurrect the account
  // here. A signed-out account keeps no connected apps at all, so it always
  // lists under the other accounts with its "Signed out" badge.
  const previouslyUsed = $derived.by(() => {
    const appOrigin = request?.appOrigin
    if (!appOrigin) {
      return []
    }
    const lastConnected = (account: Account) =>
      account.activeApps.find((app) => app.appUrl === appOrigin)?.lastConnectedAt
    return accounts
      .filter((account) => lastConnected(account) !== undefined)
      .sort((a, b) => (lastConnected(b) ?? 0) - (lastConnected(a) ?? 0))
  })
  const otherAccounts = $derived(accounts.filter((account) => !previouslyUsed.includes(account)))

  onMount(() => {
    missingRequest = !connectStore.initFromHash(window.location.hash)
  })

  async function select(account: Account) {
    if (!request) {
      return
    }
    // A still-valid prior connection carries the secret — no unlock needed.
    // (A signed-out account kept no connections, so it always falls through
    // to the unlock, which doubles as its sign-back-in ceremony.)
    if (reuseConnection(account, request)) {
      connectStore.setFirstConnect(false) // a valid entry exists by definition
      sessionStore.setCurrentAccount(account.id)
      await goto(resolve(routes.CONNECT_DONE))
      return
    }
    unlocking = account
  }

  /** Shared tail of both ceremonies: hand the secret over and close up. */
  async function finishConnect(account: Account, entropy: Uint8Array) {
    if (!request) {
      return
    }
    // Capture BEFORE the handshake writes the connected-app entry: whether the
    // account has ever used this app (removed apps' tombstones don't count).
    // The done page keys the drive-picker variant off it.
    connectStore.setFirstConnect(
      account.activeApps.every((app) => app.appUrl !== request.appOrigin),
    )
    await completeConnect(account, entropy, request)
    sessionStore.setCurrentAccount(account.id)
    unlocking = undefined
    await goto(resolve(routes.CONNECT_DONE))
  }

  async function onUnlockedConnect(entropy: Uint8Array) {
    if (unlocking) {
      await finishConnect(unlocking, entropy)
    }
  }

  function startAdding() {
    addingAccount = true
  }

  /**
   * Storage warning on a row: open that account's Storage tab in a NEW
   * window — navigating this popup away would lose the connect request
   * (held in memory, dropped on navigation by design). A signed-out account
   * signs back in first: its drives only exist in the encrypted snapshot.
   */
  function checkStorage(account: Account) {
    if (account.isSignedOut) {
      checkingStorage = account
      return
    }
    sessionStore.setCurrentAccount(account.id)
    window.open(resolve(routes.ROOT) + '?tab=drives', '_blank')
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
          <div class="flex w-full flex-col gap-4">
            {#if previouslyUsed.length > 0}
              <div class="flex flex-col gap-2">
                <p class="text-sm font-bold">Previously used with this app</p>
                <AccountList
                  accounts={previouslyUsed}
                  onselect={select}
                  oncheckstorage={checkStorage}
                />
              </div>
            {/if}

            {#if otherAccounts.length > 0}
              <div class="flex flex-col gap-2">
                {#if previouslyUsed.length > 0}
                  <p class="text-sm font-bold">Other accounts</p>
                {/if}
                <AccountList
                  accounts={otherAccounts}
                  badge={(account) => (account.isSignedOut ? 'Signed out' : undefined)}
                  onselect={select}
                  oncheckstorage={checkStorage}
                />
              </div>
            {/if}

            <div class="flex flex-col gap-2">
              <Button variant="outline" size="sm" class="w-full" onclick={notImplemented}>
                <UserUnfollowLine />
                Remove an account
              </Button>
              <Button variant="outline" size="sm" class="w-full" onclick={startAdding}>
                <UserAddFill />
                Sign in to another account
              </Button>
            </div>
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
    {/if}
  </main>
</div>

<!-- A signed-out account goes through the sign-back-in ceremony (unlock +
     state restore, incl. the no-synced-data warning) and then completes the
     connection; a signed-in one just unlocks. A mid-ceremony cross-tab
     sign-out/sign-in is caught inside the unlock dialog by its signedOutAt
     transition check. -->
{#if unlocking}
  {#if unlocking.isSignedOut}
    <SignBackInDialog
      account={unlocking}
      onsignedin={finishConnect}
      onclose={() => (unlocking = undefined)}
    />
  {:else}
    <UnlockDialog
      account={unlocking}
      title="Connect as {unlocking.name}"
      description="Unlock your account to approve the connection to {request?.appName}."
      onunlocked={onUnlockedConnect}
      onclose={() => (unlocking = undefined)}
    />
  {/if}
{/if}

<!-- Check storage on a signed-out row: sign back in (restoring the drives
     from the snapshot), then open the Storage tab in a new window so this
     popup keeps its connect request. -->
{#if checkingStorage}
  <SignBackInDialog
    account={checkingStorage}
    description={checkStorageDescription(checkingStorage)}
    onsignedin={(restored) => {
      sessionStore.setCurrentAccount(restored.id)
      window.open(resolve(routes.ROOT) + '?tab=drives', '_blank')
      checkingStorage = undefined
    }}
    onclose={() => (checkingStorage = undefined)}
  />
{/if}
