<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Unlock ceremony in a modal: collects the password, or drives the passkey /
  wallet prompt with a pending state, then hands the decrypted entropy to
  `onunlocked`. The caller closes the dialog by unmounting it on success; an
  error thrown from `onunlocked` is shown in the dialog for a retry.
-->
<script lang="ts">
  import { untrack } from 'svelte'

  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { unlockAccount } from '$lib/crypto/unlock'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    title: string
    description: string
    onunlocked: (entropy: Uint8Array) => void | Promise<void>
    onclose: () => void
  }

  let { account, title, description, onunlocked, onclose }: Props = $props()

  // The unlock ceremony only runs for a signed-in account, so the method is
  // present at mount. Read ONCE via `untrack` (not `$derived`): the method is
  // fixed for a ceremony, and an untracked read can never be re-triggered by a
  // mid-ceremony sign-out (e.g. cross-tab) — so the dialog cannot re-read
  // `accessMethod` on a wiped vault and throw. `unlockAccount` still rejects a
  // wiped vault at confirm, surfacing it as a dialog error rather than a crash.
  const access = untrack(() => account.accessMethod)

  let password = $state('')
  let busy = $state(false)
  let pendingCeremony = $state(false)
  let error = $state<string | undefined>(undefined)
  /** Bumped on cancel/retry — a stale ceremony resolution must not complete. */
  let attempt = 0

  async function confirm() {
    if (busy) {
      return
    }
    const myAttempt = ++attempt
    error = undefined
    busy = true
    if (access.type !== 'password') {
      pendingCeremony = true
    }
    try {
      const entropy = await unlockAccount(
        account,
        access.type === 'password' ? password : undefined,
      )
      if (myAttempt !== attempt) {
        return
      }
      await onunlocked(entropy)
    } catch (caught) {
      if (myAttempt === attempt) {
        error = caught instanceof Error ? caught.message : 'Unlock failed.'
        pendingCeremony = false
      }
    } finally {
      if (myAttempt === attempt) {
        busy = false
      }
    }
  }

  function close() {
    // Invalidate any in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not complete.
    attempt++
    onclose()
  }
</script>

{#if pendingCeremony}
  <Dialog onclose={close} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-4 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm font-bold">
        {access.type === 'eth-wallet' ? 'Confirm with wallet' : 'Confirm with passkey'}
      </p>
      <p class="text-sm">
        {access.type === 'eth-wallet'
          ? 'Approve the request in your Ethereum wallet.'
          : 'Follow the prompts on your device.'}
      </p>
    </div>
    <Button variant="outline" class="w-full" onclick={close}>Cancel</Button>
  </Dialog>
{:else}
  <Dialog onclose={close} {title}>
    <p class="text-sm">{description}</p>

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
      class="w-full"
      disabled={busy || (access.type === 'password' && password.length === 0)}
      onclick={confirm}
    >
      {#if busy}
        <LoaderCircle class="animate-spin" />
      {/if}
      {access.type === 'passkey'
        ? 'Confirm with passkey'
        : access.type === 'eth-wallet'
          ? 'Confirm with wallet'
          : 'Confirm'}
    </Button>
  </Dialog>
{/if}
