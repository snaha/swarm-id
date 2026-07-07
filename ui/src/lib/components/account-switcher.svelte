<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import UserRoundMinus from '@lucide/svelte/icons/user-round-minus'
  import UserRoundPlus from '@lucide/svelte/icons/user-round-plus'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import Polycon from '$lib/components/polycon.svelte'
  import SignOutDialog from '$lib/components/sign-out-dialog.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
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
  let container = $state<HTMLDivElement>()
  /** Replaces the panel actions with the create/import choice. */
  let addingAccount = $state(false)
  let signingOut = $state(false)

  const others = $derived(
    accountsStore.accounts.filter((candidate) => !candidate.id.equals(account.id)),
  )

  function close() {
    open = false
    addingAccount = false
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (open && container && !container.contains(event.target as Node)) {
      close()
    }
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      close()
    }
  }

  function select(candidate: Account) {
    if (candidate.isSignedOut) {
      // No keys on this device — signing back in means importing the phrase.
      close()
      void goto(resolve(routes.ACCOUNT_IMPORT))
      return
    }
    sessionStore.setCurrentAccount(candidate.id)
    close()
  }

  function startSignOut() {
    close()
    signingOut = true
  }

  function manage() {
    close()
    onmanage?.()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div bind:this={container} class="relative">
  <Button
    variant="ghost"
    class="h-10 gap-2 px-2"
    aria-label="Switch account"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? close() : (open = true))}
  >
    <span class="flex flex-col items-end">
      <span class="text-sm font-medium">{account.name}</span>
      <span class="text-muted-foreground text-xs font-normal">
        {truncateAddress(account.id.toChecksum())}
      </span>
    </span>
    <Polycon value={account.id.toHex()} size={32} class="shrink-0 overflow-hidden rounded-lg" />
  </Button>

  {#if open}
    <div
      role="menu"
      tabindex="-1"
      class="bg-popover text-popover-foreground absolute top-0 right-0 z-50 flex w-80 flex-col gap-4 rounded-lg border p-2.5 shadow-md"
    >
      <div class="flex flex-col gap-2">
        <div class="flex flex-col items-center gap-2 pt-0.5">
          <Polycon value={account.id.toHex()} size={48} class="overflow-hidden rounded-lg" />
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
              <button
                type="button"
                role="menuitem"
                class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-md p-1 text-left outline-none"
                onclick={() => select(candidate)}
              >
                <Polycon
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
              </button>
            {/each}
          </div>
        {/if}

        <div class="flex flex-col gap-2">
          {#if others.length > 0}
            <Button variant="ghost" size="sm" class="w-full" onclick={notImplemented}>
              <UserRoundMinus />
              Remove an account
            </Button>
          {/if}
          <Button variant="ghost" size="sm" class="w-full" onclick={() => (addingAccount = true)}>
            <UserRoundPlus />
            Sign in to another account
          </Button>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if signingOut}
  <SignOutDialog {account} onClose={() => (signingOut = false)} />
{/if}
