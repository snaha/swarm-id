<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import UserRoundMinus from '@lucide/svelte/icons/user-round-minus'
  import UserRoundPlus from '@lucide/svelte/icons/user-round-plus'

  import { resolve } from '$app/paths'

  import Polycon from '$lib/components/polycon.svelte'
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
    sessionStore.setCurrentAccount(candidate.id)
    close()
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
      class="bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-2 flex w-72 flex-col gap-2 rounded-lg border p-2 shadow-md"
    >
      <div class="flex flex-col items-center gap-1 py-2">
        <Polycon value={account.id.toHex()} size={48} class="overflow-hidden rounded-lg" />
        <div class="flex flex-col items-center">
          <p class="text-sm font-medium">{account.name}</p>
          <p class="text-muted-foreground text-xs">{truncateAddress(account.id.toChecksum())}</p>
        </div>
      </div>

      <Button variant="outline" size="sm" class="w-full" onclick={manage}>Manage account</Button>
      <Button variant="outline" size="sm" class="w-full" onclick={notImplemented}>Sign out</Button>

      {#if addingAccount}
        <Button variant="ghost" size="xs" class="w-full" href={resolve(routes.ACCOUNT_NEW)}>
          Create a new account
        </Button>
        <Button variant="ghost" size="xs" class="w-full" href={resolve(routes.ACCOUNT_IMPORT)}>
          I already have an account
        </Button>
      {:else}
        {#each others as candidate (candidate.id.toHex())}
          <button
            type="button"
            role="menuitem"
            class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none"
            onclick={() => select(candidate)}
          >
            <Polycon
              value={candidate.id.toHex()}
              size={28}
              class="shrink-0 overflow-hidden rounded-md"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-sm font-medium">{candidate.name}</span>
              <span class="text-muted-foreground text-xs">
                {truncateAddress(candidate.id.toChecksum())}
              </span>
            </span>
          </button>
        {/each}

        {#if others.length > 0}
          <Button variant="ghost" size="xs" class="w-full" onclick={notImplemented}>
            <UserRoundMinus />
            Remove an account
          </Button>
        {/if}
        <Button variant="ghost" size="xs" class="w-full" onclick={() => (addingAccount = true)}>
          <UserRoundPlus />
          Add an account
        </Button>
      {/if}
    </div>
  {/if}
</div>
