<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import CircleCheck from '@lucide/svelte/icons/circle-check'

  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import AppHeader from '$lib/components/app-header.svelte'
  import DriveAddDialog from '$lib/components/drive-add-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'
  import { truncateAddress } from '$lib/utils'

  interface Props {
    account: Account
    /** Initial toast message; auto-dismissed. */
    toast: string
    /** Label of the finish button (e.g. "Stay local for now", "Continue to app"). */
    finishLabel: string
    /** Body text when the account already has a drive and the pitch is skipped. */
    doneMessage: string
    /** Called by the finish button and after a drive is added. */
    onFinish: () => void
  }

  const { account, toast, finishLabel, doneMessage, onFinish }: Props = $props()

  const AVATAR_SIZE = 80

  const hasDrive = $derived(account.postageStamps.length > 0)

  let addDriveOpen = $state(false)

  onMount(() => {
    if (toast) {
      toastStore.show(toast)
    }
  })
</script>

<div class="flex min-h-svh flex-col">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-center gap-8">
      <div class="flex w-full flex-col items-center gap-4">
        <AccountAvatar
          value={account.id.toHex()}
          size={AVATAR_SIZE}
          class="shrink-0 overflow-hidden rounded-lg"
        />
        <div class="flex w-full flex-col items-center gap-2 text-center">
          <p class="w-full truncate text-lg leading-none font-bold">{account.name}</p>
          <p class="text-sm">{truncateAddress(account.id.toChecksum())}</p>
        </div>
      </div>

      {#if hasDrive}
        <div class="flex flex-col items-center gap-2 text-center">
          <CircleCheck class="size-5" />
          <p class="text-sm font-bold">All set!</p>
          <p class="text-sm">{doneMessage}</p>
        </div>

        <Button class="w-full" onclick={onFinish}>{finishLabel}</Button>
      {:else}
        <div class="flex w-full flex-col gap-4">
          <p class="text-center text-base">
            Your Swarm ID is ready! You can browse and view content on this device straight away.
          </p>

          <div class="bg-muted flex w-full flex-col items-center rounded-xl p-2 text-center">
            <p class="text-sm font-bold">Want the full experience?</p>
            <p class="text-sm">
              Upload data and sync your Swarm ID across devices with a Swarm drive.
            </p>
          </div>
        </div>

        <div class="flex w-full flex-col items-center gap-4">
          <div class="flex w-full flex-col items-center gap-2">
            <Button class="w-full" onclick={() => (addDriveOpen = true)}>Set up a drive</Button>
            <Button variant="outline" class="w-full" onclick={onFinish}>{finishLabel}</Button>
          </div>

          <p class="text-muted-foreground text-center text-xs">
            Local accounts are limited to viewing content and cannot be used on other devices.
          </p>
        </div>
      {/if}
    </div>
  </main>

  {#if addDriveOpen}
    <DriveAddDialog {account} onClose={() => (addDriveOpen = false)} onAdded={onFinish} />
  {/if}
</div>
