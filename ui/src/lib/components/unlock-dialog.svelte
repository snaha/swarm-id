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

  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
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
    /** Above the body — e.g. the account the ceremony is about. */
    header?: Snippet
    /** Richer body than a plain string — rendered in place of `description`. */
    children?: Snippet
    /** Below the password field, above the confirm button. */
    footer?: Snippet
    /** Labels the password field; without it the placeholder alone names it. */
    passwordLabel?: string
    /** The caller's own precondition for confirming (e.g. a typed name). */
    canConfirm?: boolean
    /** Overrides the access-method-derived confirm label. */
    confirmLabel?: string
    /** Overrides the heading of the passkey / wallet waiting state. */
    pendingTitle?: string
    /** Destructive confirm styling for delete-style ceremonies. */
    destructive?: boolean
    /** Extra classes for the form dialog, e.g. a wider panel. */
    class?: string
    onunlocked: (entropy: Uint8Array) => void | Promise<void>
    onclose: () => void
  }

  let {
    account,
    title,
    description,
    header,
    children,
    footer,
    passwordLabel,
    canConfirm = true,
    confirmLabel,
    pendingTitle,
    destructive = false,
    class: className,
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
  let passwordShown = $state(false)
  let busy = $state(false)
  let pendingCeremony = $state(false)
  let error = $state<string | undefined>(undefined)
  /** Cancel/retry supersedes the in-flight ceremony — it must not complete. */
  const attempts = createAttemptTracker()

  const confirmable = $derived(canConfirm && (access.type !== 'password' || password.length > 0))

  async function confirm() {
    if (busy || !confirmable) {
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
        {pendingTitle ??
          (access.type === 'eth-wallet' ? 'Confirm with wallet' : 'Confirm with passkey')}
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
  <Dialog onclose={close} {title} class={className}>
    {@render header?.()}

    {#if children}
      {@render children()}
    {:else if description}
      <p class="text-sm">{description}</p>
    {/if}

    {#if access.type === 'password'}
      <div class="flex w-full flex-col gap-2">
        {#if passwordLabel}
          <label for="unlock-password" class="text-sm font-medium">{passwordLabel}</label>
        {/if}
        <div class="flex w-full items-center gap-2">
          <Input
            id="unlock-password"
            type={passwordShown ? 'text' : 'password'}
            bind:value={password}
            placeholder="Account password"
            autocomplete="current-password"
            data-autofocus
            onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirm()}
          />
          <Button
            variant="ghost"
            size="icon"
            class="size-6 shrink-0 rounded-md [&_svg]:size-3.5"
            aria-label={passwordShown ? 'Hide password' : 'Show password'}
            onclick={() => (passwordShown = !passwordShown)}
          >
            {#if passwordShown}
              <EyeOff />
            {:else}
              <Eye />
            {/if}
          </Button>
        </div>
      </div>
    {/if}

    {@render footer?.()}

    {#if error}
      <p class="text-destructive text-xs">{error}</p>
    {/if}

    <Button
      variant={destructive ? 'destructive' : 'default'}
      class="w-full"
      disabled={busy || !confirmable}
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
