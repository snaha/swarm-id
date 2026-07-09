<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Delete an account from THIS device. Unlike sign-out (which keeps a tombstone
  row and can be reversed with the recovery phrase), delete hard-removes the
  record via `accountsStore.remove`. Because it is destructive and irreversible
  for a local account, it is gated on the account's own access method: the user
  must re-confirm with their passkey, wallet, or password (`unlockAccount`)
  before the record is dropped. The decrypted seed is proof-of-control only and
  is zeroed immediately.
-->
<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { unlockAccount } from '$lib/crypto/unlock'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    onClose: () => void
  }

  let { account, onClose }: Props = $props()

  // The Account tab only renders for the signed-in current account, so the
  // access method is always present (`accessMethod` asserts it).
  const access = $derived(account.accessMethod)

  let password = $state('')
  let busy = $state(false)
  // Passkey/wallet prompt in flight — swaps to the centered pending body.
  let pending = $state(false)
  let error = $state<string | undefined>(undefined)
  // Bumped on cancel/close so a passkey/wallet prompt that resolves after the
  // user dismissed the dialog does not go on to delete the account.
  let attempt = 0

  const confirmLabel = $derived(
    access.type === 'passkey'
      ? 'Confirm delete with passkey'
      : access.type === 'eth-wallet'
        ? 'Confirm delete with ETH wallet'
        : 'Confirm delete with password',
  )

  function cancel() {
    attempt++
    onClose()
  }

  async function confirm() {
    if (busy) {
      return
    }
    const myAttempt = ++attempt
    error = undefined
    busy = true
    if (access.type !== 'password') {
      pending = true
    }
    try {
      const seed = await unlockAccount(account, access.type === 'password' ? password : undefined)
      // Deletion needs proof-of-control, not the seed itself. Zero it, and bail
      // if the dialog was dismissed while the prompt was open (an approval of a
      // cancelled prompt must not delete the account).
      seed.fill(0)
      if (myAttempt !== attempt) {
        return
      }
      const target = account
      accountsStore.remove(target.id)
      if (sessionStore.currentAccountId === target.id.toHex()) {
        sessionStore.clearCurrentAccount()
      }
      toastStore.show('Account deleted')
      onClose()
    } catch (caught) {
      if (myAttempt === attempt) {
        error = caught instanceof Error ? caught.message : 'Could not delete the account.'
        busy = false
        pending = false
      }
    }
  }
</script>

{#if pending}
  <Dialog onclose={cancel} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-2">
      <LoaderCircle class="size-5 animate-spin" />
      <div class="flex flex-col items-center text-center">
        <p class="text-sm font-bold">
          {access.type === 'eth-wallet' ? 'Confirm with wallet' : 'Confirm with passkey'}
        </p>
        <p class="text-sm">
          {access.type === 'eth-wallet'
            ? 'Approve the request in your Ethereum wallet.'
            : 'Follow the prompts on your device.'}
        </p>
      </div>
    </div>
    <Button variant="outline" class="w-full" onclick={cancel}>Cancel</Button>
  </Dialog>
{:else}
  <Dialog onclose={cancel} title="Delete account">
    <p class="text-sm">
      This permanently deletes <span class="font-medium">{account.name}</span> from this device. Your
      account and its data may not be recoverable.
    </p>

    {#if access.type === 'password'}
      <Input
        type="password"
        bind:value={password}
        placeholder="Account password"
        autocomplete="current-password"
        onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirm()}
      />
    {/if}

    {#if error}
      <p class="text-destructive text-xs">{error}</p>
    {/if}

    <Button
      variant="destructive"
      class="w-full"
      disabled={busy || (access.type === 'password' && password.length === 0)}
      onclick={confirm}
    >
      {#if busy}
        <LoaderCircle class="animate-spin" />
      {/if}
      {confirmLabel}
    </Button>
  </Dialog>
{/if}
