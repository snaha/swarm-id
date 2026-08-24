<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Post-connect confirmation. The secret was already delivered by
  completeConnect, so every variant confirms and offers "Go to app"; the
  middle varies (SwarmID-MVP frames 396:17501 / 395:13966 / 395:13889):
  - first connect to an account with several drives: pick the drive this app
    stores to (persisted as the app's postageStampBatchID; choosing the
    default leaves the pointer unset so the app tracks the account default);
  - no drives yet: the drive pitch, demoted to a secondary card;
  - anything else: plain confirmation.
-->
<script lang="ts">
  import { onMount } from 'svelte'

  import { BatchId } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import AppHeader from '$lib/components/app-header.svelte'
  import DriveAddDialog from '$lib/components/drive-add-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Select, type SelectOption } from '$lib/components/ui/select'
  import { driveDisplayName } from '$lib/drives'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import { truncateAddress } from '$lib/utils'

  const AVATAR_SIZE = 80

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )
  const request = connectStore.request

  const drives = $derived(account?.stamps ?? [])
  const defaultBatchHex = $derived(
    account?.defaultPostageStampBatchID?.toHex() ?? drives[0]?.batchID.toHex(),
  )
  const showPicker = $derived(connectStore.firstConnect && drives.length > 1)
  const showPitch = $derived(drives.length === 0)

  const driveOptions = $derived<SelectOption[]>(
    drives.map((drive) => ({
      value: drive.batchID.toHex(),
      label:
        driveDisplayName(drive) + (drive.batchID.toHex() === defaultBatchHex ? ' (default)' : ''),
    })),
  )
  /** The user's explicit choice; the account default until they touch it. */
  let chosenBatchHex = $state<string | undefined>(undefined)
  const selectedBatchHex = $derived(chosenBatchHex ?? defaultBatchHex)

  let addDriveOpen = $state(false)

  onMount(() => {
    if (!account || !request) {
      goto(resolve(routes.ROOT))
      return
    }
    toastStore.show(`Connected to ${request.appName}!`)
  })

  function goToApp() {
    // Persist the drive choice only when it deviates from the account default
    // — an untouched or default choice keeps following the default.
    if (account && request && showPicker && selectedBatchHex !== defaultBatchHex) {
      account.setAppStamp(request.appOrigin, new BatchId(selectedBatchHex))
    }
    connectStore.clear()
    window.close()
  }
</script>

{#if account && request}
  <div class="flex min-h-svh flex-col">
    <AppHeader />

    <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
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

        <div class="flex w-full flex-col gap-4">
          <p class="text-center text-base">
            Your Swarm ID is now connected to {request.appName}!
          </p>

          {#if showPicker}
            <div class="flex w-full flex-col gap-2">
              <p class="text-sm">Select drive</p>
              <Select
                options={driveOptions}
                value={selectedBatchHex}
                onchange={(value) => (chosenBatchHex = value)}
              />
              <p class="text-muted-foreground text-sm">Where this app will store data</p>
            </div>
          {/if}

          <Button class="w-full" onclick={goToApp}>
            Go to app
            <ArrowRight />
          </Button>
        </div>

        {#if showPitch}
          <div class="bg-muted flex w-full flex-col gap-2 rounded-xl p-2 text-center">
            <div class="flex flex-col">
              <p class="text-sm font-bold">Want the full experience?</p>
              <p class="text-sm">
                Upload data and sync your Swarm ID across devices with a Swarm drive.
              </p>
            </div>
            <Button variant="outline" class="w-full" onclick={() => (addDriveOpen = true)}>
              Set up a drive
            </Button>
          </div>
        {/if}
      </div>
    </main>

    {#if addDriveOpen}
      <DriveAddDialog {account} onClose={() => (addDriveOpen = false)} onAdded={toastStore.show} />
    {/if}
  </div>
{/if}
