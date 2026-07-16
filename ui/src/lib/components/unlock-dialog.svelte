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
  import { type Snippet, untrack } from 'svelte'

  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  import { createAttemptTracker } from '$lib/attempt'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { unlockAccount } from '$lib/crypto/unlock'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    title: string
    description?: string
    /** Richer body than a plain string — rendered in place of `description`. */
    children?: Snippet
    /** Overrides the access-method-derived confirm label. */
    confirmLabel?: string
    /** Destructive confirm styling for delete-style ceremonies. */
    destructive?: boolean
    onunlocked: (entropy: Uint8Array) => void | Promise<void>
    onclose: () => void
  }

  let {
    account,
    title,
    description,
    children,
    confirmLabel,
    destructive = false,
    onunlocked,
    onclose,
  }: Props = $props()

  // The method is fixed for a ceremony — read ONCE via `untrack` (not
  // `$derived`) so a mid-ceremony record change (e.g. cross-tab) can never
  // re-render the dialog against different access metadata.
  const access = untrack(() => account.accessMethod)
  // Snapshot the sign-out state to detect a mid-ceremony transition below:
  // this dialog serves both signed-in unlocks and sign-back-in ceremonies, so
  // what invalidates a ceremony is the state CHANGING under it, not being
  // signed out per se.
  const initialSignedOutAt = untrack(() => account.signedOutAt)

  let password = $state('')
  let busy = $state(false)
  let pendingCeremony = $state(false)
  let error = $state<string | undefined>(undefined)
  /** Cancel/retry supersedes the in-flight ceremony — it must not complete. */
  const attempts = createAttemptTracker()

  async function confirm() {
    if (busy) {
      return
    }
    const attempt = attempts.begin()
    error = undefined
    busy = true
    if (access.type !== 'password') {
      pendingCeremony = true
    }
    try {
      // A passkey/wallet unlock can take seconds; a ceremony superseded while
      // it ran (cancel/retry) must not complete, and its decrypted entropy is
      // zeroed on the way out.
      const entropy = await attempt.guard(
        unlockAccount(account, access.type === 'password' ? password : undefined),
        (seed) => seed.fill(0),
      )
      // Bail if the account's sign-out state flipped mid-flight (e.g.
      // cross-tab) — supersession itself is the attempt guard's job. A
      // signed-in unlock completing after a sign-out would re-arm app session
      // material the sign-out just cleared; a sign-back-in completing after
      // another tab already signed back in (or re-signed-out) would act on a
      // state it no longer knows.
      if (account.signedOutAt !== initialSignedOutAt) {
        entropy.fill(0)
        return
      }
      await onunlocked(entropy)
    } catch (caught) {
      if (attempt.current) {
        error = caught instanceof Error ? caught.message : 'Unlock failed.'
        pendingCeremony = false
      }
    } finally {
      if (attempt.current) {
        busy = false
      }
    }
  }

  function close() {
    // Invalidate any in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not complete.
    attempts.supersede()
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
    {#if children}
      {@render children()}
    {:else if description}
      <p class="text-sm">{description}</p>
    {/if}

    {#if access.type === 'password'}
      <Input
        type="password"
        bind:value={password}
        placeholder="Account password"
        autocomplete="current-password"
        data-autofocus
        onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirm()}
      />
    {/if}

    {#if error}
      <p class="text-destructive text-xs">{error}</p>
    {/if}

    <Button
      variant={destructive ? 'destructive' : 'default'}
      class="w-full"
      disabled={busy || (access.type === 'password' && password.length === 0)}
      onclick={confirm}
    >
      {#if busy}
        <LoaderCircle class="animate-spin" />
      {/if}
      {confirmLabel ??
        (access.type === 'passkey'
          ? 'Confirm with passkey'
          : access.type === 'eth-wallet'
            ? 'Confirm with wallet'
            : 'Confirm')}
    </Button>
  </Dialog>
{/if}
