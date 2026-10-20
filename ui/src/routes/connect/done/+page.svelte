<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  Post-connect confirmation, and where the connection is committed: the
  chooser hands over the unlocked account (`connectStore.pending`), the user
  settles the drives, and "Go to app" runs the handshake with the grant —
  so a partitioned session is handed exactly the drives the grant names
  (#862). The middle varies with what the app asked for (SwarmID-MVP,
  sections OPTION 1 / OPTION 2):
  - a list of drives: one row each, regular rows first, with a select over
    the account's drives of that kind — "Add new drive…" last — or an Add
    button when it has none. Required rows gate "Go to app";
  - "all": one checkbox, with the live-grant warning;
  - an empty list: no drive at all, nothing to pick;
  - no request: the account default, picked among several on a first
    connect (persisted only when it deviates from the default, so the app
    keeps tracking the default otherwise), or the drive pitch when there is
    none.
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
  import { type DriveGrant, commitConnect } from '$lib/connect-handshake'
  import {
    ADD_NEW_DRIVE,
    type PickerRow,
    kindOf,
    pickerRows,
    rowChoices,
    rowsComplete,
    rowsGrant,
  } from '$lib/drive-request'
  import { driveDisplayName } from '$lib/drives'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import { truncateAddress } from '$lib/utils'

  const AVATAR_SIZE = 80
  /** The pitch's dialog creates for no row. */
  const NO_ROW = -1

  const account = $derived(
    sessionStore.currentAccountId ? accountsStore.get(sessionStore.currentAccountId) : undefined,
  )
  const request = connectStore.request
  const pending = connectStore.pending
  const requested = request?.permissions?.drives

  const drives = $derived(account?.stamps ?? [])
  const regularDrives = $derived(drives.filter((drive) => kindOf(drive) === 'regular'))
  const defaultBatchHex = $derived(
    account?.defaultPostageStampBatchID?.toHex() ?? regularDrives[0]?.batchID.toHex(),
  )
  const legacyPicker = $derived(
    requested === undefined && connectStore.firstConnect && regularDrives.length > 1,
  )
  const showPitch = $derived(requested === undefined && regularDrives.length === 0)

  let rows = $state<PickerRow[]>([])
  let grantAll = $state(false)
  /** The legacy picker's explicit choice; the account default until touched. */
  let chosenBatchHex = $state<string | undefined>(undefined)
  const selectedBatchHex = $derived(chosenBatchHex ?? defaultBatchHex)
  /** The row the Add drive dialog is creating for; `NO_ROW` for the pitch. */
  let addingFor = $state<number | undefined>(undefined)
  /** Re-mounts the selects after the dialog closes: a cancelled "Add new
   * drive…" left the native select on that entry with the row unchanged. */
  let selectEpoch = $state(0)
  let batchesBeforeAdd = new Set<string>()

  const canGo = $derived(requested === 'all' ? grantAll : rowsComplete(rows))

  const legacyOptions = $derived<SelectOption[]>(
    regularDrives.map((drive) => ({
      value: drive.batchID.toHex(),
      label: labelFor(drive.batchID.toHex(), driveDisplayName(drive)),
    })),
  )

  function labelFor(batchHex: string, name: string): string {
    return name + (batchHex === defaultBatchHex ? ' (default)' : '')
  }

  function optionsFor(index: number): SelectOption[] {
    const choices = rowChoices(rows, index, drives).map((drive) => ({
      value: drive.batchID.toHex(),
      label: labelFor(drive.batchID.toHex(), driveDisplayName(drive)),
    }))
    return [
      ...(rows[index].optional ? [{ value: '', label: 'None' }] : []),
      ...choices,
      { value: ADD_NEW_DRIVE, label: 'Add new drive…' },
    ]
  }

  function choose(index: number, value: string) {
    if (value === ADD_NEW_DRIVE) {
      openAddDialog(index)
    } else {
      rows[index].chosen = value
    }
  }

  function openAddDialog(index: number) {
    batchesBeforeAdd = new Set(drives.map((drive) => drive.batchID.toHex()))
    addingFor = index
  }

  function closeAddDialog() {
    addingFor = undefined
    selectEpoch += 1
  }

  /** The dialog added a drive: the row it was opened for takes it. */
  function onDriveAdded(message: string) {
    toastStore.show(message)
    const added = drives.find((drive) => !batchesBeforeAdd.has(drive.batchID.toHex()))
    if (addingFor !== undefined && addingFor !== NO_ROW && added) {
      rows[addingFor].chosen = added.batchID.toHex()
    }
  }

  onMount(() => {
    if (!account || !request || !pending) {
      goto(resolve(routes.ROOT))
      return
    }
    if (Array.isArray(requested)) {
      rows = pickerRows(requested, drives, defaultBatchHex)
    }
  })

  function grantFor(): DriveGrant | undefined {
    if (requested === 'all') {
      return { drives: 'all' }
    }
    if (Array.isArray(requested)) {
      return { drives: rowsGrant(rows).map((batchHex) => new BatchId(batchHex)) }
    }
    if (legacyPicker && selectedBatchHex !== defaultBatchHex) {
      return { drives: [new BatchId(selectedBatchHex)] }
    }
    return undefined
  }

  function goToApp() {
    if (!account || !request || !pending || !canGo) {
      return
    }
    commitConnect(account, request, pending.appSecret, grantFor())
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
          <p class="text-center text-base">Connect your Swarm ID to {request.appName}</p>
          {#if requested === 'all'}
            <label class="flex w-full items-start gap-2 text-sm">
              <input type="checkbox" bind:checked={grantAll} class="mt-0.5 size-4 shrink-0" />
              <span class="flex flex-col gap-1">
                <span class="font-medium">Grant this app full drive access</span>
                <span class="text-muted-foreground">
                  This app is requesting access to all drives in your account, including any drives
                  you add in the future. Only grant this if you trust the app developer.
                </span>
              </span>
            </label>
          {:else if Array.isArray(requested)}
            {#each rows as row, index (index)}
              <div class="flex w-full flex-col gap-2">
                <p class="text-sm">
                  {row.kind === 'scratch' ? 'Scratch drive' : 'Drive'}{row.optional
                    ? ' (optional)'
                    : ''}
                </p>
                {#if rowChoices(rows, index, drives).length > 0}
                  {#key selectEpoch}
                    <Select
                      options={optionsFor(index)}
                      value={row.chosen}
                      onchange={(value) => choose(index, value)}
                    />
                  {/key}
                {:else}
                  <Button variant="outline" class="w-full" onclick={() => openAddDialog(index)}>
                    {row.kind === 'scratch' ? 'Add scratch drive' : 'Add drive'}
                  </Button>
                {/if}
                <p class="text-muted-foreground text-sm">{row.description}</p>
              </div>
            {/each}
          {:else if legacyPicker}
            <div class="flex w-full flex-col gap-2">
              <p class="text-sm">Select drive</p>
              <Select
                options={legacyOptions}
                value={selectedBatchHex}
                onchange={(value) => (chosenBatchHex = value)}
              />
              <p class="text-muted-foreground text-sm">Where this app will store data</p>
            </div>
          {/if}
          <Button class="w-full" onclick={goToApp} disabled={!canGo}>
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
            <Button variant="outline" class="w-full" onclick={() => openAddDialog(NO_ROW)}>
              Set up a drive
            </Button>
          </div>
        {/if}
      </div>
    </main>

    {#if addingFor !== undefined}
      <DriveAddDialog
        {account}
        kind={addingFor === NO_ROW ? undefined : rows[addingFor].kind}
        onClose={closeAddDialog}
        onAdded={onDriveAdded}
      />
    {/if}
  </div>
{/if}
