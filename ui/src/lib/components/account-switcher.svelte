<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { resolve } from '$app/paths'

  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import UserAddFill from '$lib/components/icons/user-add-fill.svelte'
  import UserUnfollowLine from '$lib/components/icons/user-unfollow-line.svelte'
  import SignBackInDialog from '$lib/components/sign-back-in-dialog.svelte'
  import SignOutDialog from '$lib/components/sign-out-dialog.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { DropdownMenu, DropdownMenuItem } from '$lib/components/ui/dropdown-menu'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { Account } from '$lib/types'
  import { notImplemented, truncateAddress } from '$lib/utils'

  interface Props {
    account: Account
    /** Called when the user picks "Manage account" (opens the Account tab). */
    onmanage?: () => void
  }

  let { account, onmanage }: Props = $props()

  let open = $state(false)
  /** Replaces the panel actions with the create/import choice. */
  let addingAccount = $state(false)
  let signingOut = $state(false)
  /** Signed-out account being unlocked to sign back in. */
  let signingBackIn = $state<Account | undefined>(undefined)

  const others = $derived(
    accountsStore.accounts.filter((candidate) => !candidate.id.equals(account.id)),
  )

  // However the menu closes (item click, outside pointerdown, Escape), the
  // next open starts back on the main actions.
  $effect(() => {
    if (!open) {
      addingAccount = false
    }
  })

  function select(candidate: Account) {
    if (candidate.isSignedOut) {
      // The vault survived the sign-out — unlock it to sign back in.
      signingBackIn = candidate
      return
    }
    sessionStore.setCurrentAccount(candidate.id)
  }

  function startSignOut() {
    open = false
    signingOut = true
  }

  function manage() {
    open = false
    onmanage?.()
  }
</script>

<DropdownMenu bind:open class="top-0 right-0 flex w-80 flex-col gap-4 p-2.5">
  {#snippet trigger(props)}
    <Button variant="ghost" class="h-10 gap-2 px-2" aria-label="Switch account" {...props}>
      <span class="flex flex-col items-end">
        <span class="text-sm font-medium">{account.name}</span>
        <span class="text-muted-foreground text-xs font-normal">
          {truncateAddress(account.id.toChecksum())}
        </span>
      </span>
      <AccountAvatar
        value={account.id.toHex()}
        size={32}
        class="shrink-0 overflow-hidden rounded-lg"
      />
    </Button>
  {/snippet}

  <div class="flex flex-col gap-2">
    <div class="flex flex-col items-center gap-2 pt-0.5">
      <AccountAvatar value={account.id.toHex()} size={48} class="overflow-hidden rounded-lg" />
      <div class="flex flex-col items-center">
        <p class="text-sm font-medium">{account.name}</p>
        <p class="text-muted-foreground text-xs">{truncateAddress(account.id.toChecksum())}</p>
      </div>
    </div>

    <Button variant="outline" class="w-full" onclick={manage}>Manage account</Button>
    <!-- A local account has nothing on Swarm to come back to — signing it out
         would destroy it, so it only gets Delete (on the Account tab), no Sign out. -->
    {#if !account.isLocal}
      <Button variant="outline" class="w-full" onclick={startSignOut}>Sign out</Button>
    {/if}
  </div>

  {#if addingAccount}
    <div class="flex flex-col gap-2">
      <Button variant="ghost" size="sm" class="w-full" href={resolve(routes.ACCOUNT_NEW)}>
        Create a new account
      </Button>
      <Button variant="ghost" size="sm" class="w-full" href={resolve(routes.ACCOUNT_IMPORT)}>
        I already have an account
      </Button>
    </div>
  {:else}
    {#if others.length > 0}
      <div class="flex flex-col">
        {#each others as candidate (candidate.id.toHex())}
          <DropdownMenuItem class="h-auto gap-2 p-1" onclick={() => select(candidate)}>
            <AccountAvatar
              value={candidate.id.toHex()}
              size={36}
              class="shrink-0 overflow-hidden rounded-md"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-sm font-medium">{candidate.name}</span>
              <span class="text-muted-foreground text-xs">
                {truncateAddress(candidate.id.toChecksum())}
              </span>
            </span>
            {#if candidate.isSignedOut}
              <Badge>Signed out</Badge>
            {/if}
          </DropdownMenuItem>
        {/each}
      </div>
    {/if}

    <div class="flex flex-col gap-2">
      {#if others.length > 0}
        <Button variant="ghost" size="sm" class="w-full" onclick={notImplemented}>
          <UserUnfollowLine />
          Remove an account
        </Button>
      {/if}
      <Button variant="ghost" size="sm" class="w-full" onclick={() => (addingAccount = true)}>
        <UserAddFill />
        Sign in to another account
      </Button>
    </div>
  {/if}
</DropdownMenu>

{#if signingOut}
  <SignOutDialog {account} onClose={() => (signingOut = false)} />
{/if}

{#if signingBackIn}
  <SignBackInDialog
    account={signingBackIn}
    onsignedin={(restored) => {
      sessionStore.setCurrentAccount(restored.id)
      signingBackIn = undefined
    }}
    onclose={() => (signingBackIn = undefined)}
  />
{/if}
