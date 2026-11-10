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

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import UnlockPendingDialog from '$lib/components/unlock-pending-dialog.svelte'
  import type { Account } from '$lib/types'
  import { createUnlockCeremony } from '$lib/unlock-ceremony.svelte'

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

  const ceremony = untrack(() => createUnlockCeremony(account, (entropy) => onunlocked(entropy)))
  const access = ceremony.access

  let password = $state('')

  function confirm() {
    if (access.type === 'password' && password.length === 0) {
      return
    }
    void ceremony.confirm(password)
  }

  function close() {
    ceremony.cancel()
    onclose()
  }
</script>

{#if ceremony.pending}
  <UnlockPendingDialog {ceremony} oncancel={close} />
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

    {#if ceremony.error}
      <p class="text-destructive text-xs">{ceremony.error}</p>
    {/if}

    <Button
      variant={destructive ? 'destructive' : 'default'}
      class="w-full"
      disabled={ceremony.busy || (access.type === 'password' && password.length === 0)}
      onclick={confirm}
    >
      {#if ceremony.busy}
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
