<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  "Permissions for <app>" (#711; SwarmID-MVP, section PERMISSIONS). One page,
  two ways in:
  - an app's request (`requestDrives()`), in a popup: only what it asked for,
    every row empty, and saving with nothing chosen grants nothing. The new
    drives are added to what the app already holds;
  - the Apps tab's "Permissions": everything the app holds, where a drive
    set to "None" is taken away and unticking "all" falls back to the
    account default.
  Beside the drives, the two sharing switches (#885): a request shows the
  ones asked for, an edit both (write access once data sharing is on). Each
  shows the app's pin or the account default; moving one pins it, and "Use
  account default" unpins it.
  A grant is a write to the account record, so nothing is unlocked here —
  which is why the page refuses to render inside a frame, and grants on
  request only to an app with a live connection. Editing is reachable by URL
  for a disconnected app too, on purpose: it can only swap or drop what the
  stored grant already holds, never widen it. The grant reaches the app's live
  session as a storage event or an account-bus delta; a partitioned session
  that opened this popup is handed it directly, and one whose popup the page
  had to open instead waits for the bus delta to leave before closing.
-->
<script lang="ts">
  import { onMount } from 'svelte'

  import { accountDeltaSnapshot } from '@snaha/swarm-id/internal'
  import type { AppPermissions, PermissionName } from '@snaha/swarm-id/internal'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import DriveAddDialog from '$lib/components/drive-add-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Select, type SelectOption } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { ADD_NEW_DRIVE, type PickerRow, kindOf, rowChoices, rowsGrant } from '$lib/drive-request'
  import { driveDisplayName } from '$lib/drives'
  import {
    type PermissionsPageRequest,
    SWITCH_COPY,
    editRows,
    grantAfterEdit,
    grantAfterRequest,
    grantableOnRequest,
    parsePermissionsHash,
    pinnedDifferently,
    requestRows,
    sameGrant,
    sharingAfterSave,
    sharingDefault,
    switchValues,
    switchesToShow,
    unknownDriveLabel,
  } from '$lib/permissions-request'
  import routes from '$lib/routes'
  import { accountBusStore } from '$lib/stores/account-bus'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'

  const ICON_SIZE = 48

  let page = $state<PermissionsPageRequest | undefined>(undefined)
  let rows = $state<PickerRow[]>([])
  let allTicked = $state(false)
  /** The sharing switches (#885): what they showed at load, and show now. */
  let initialSharing: AppPermissions = { dataSharing: true, writeAccess: true }
  let sharing = $state<AppPermissions>({ dataSharing: true, writeAccess: true })
  // An array, not a Set: `$state` proxies arrays, so the helper line reacts.
  let resets = $state<PermissionName[]>([])
  let addingFor = $state<number | undefined>(undefined)
  /** Re-mounts the selects after the dialog closes (see the connect done page). */
  let selectEpoch = $state(0)
  let batchesBeforeAdd = new Set<string>()
  let saving = $state(false)
  /** Rendered inside another site: a grant is one click, so refuse (clickjacking). */
  let framed = $state(false)

  const requesting = $derived(page?.permissions !== undefined)
  const requested = $derived(page?.permissions?.drives)
  const account = $derived.by(() => {
    const id = page?.accountId ?? sessionStore.currentAccountId
    return id ? accountsStore.get(id) : undefined
  })
  const app = $derived(account?.activeApps.find((entry) => entry.appUrl === page?.appOrigin))
  const drives = $derived(account?.stamps ?? [])
  const defaultBatchHex = $derived(
    account?.defaultPostageStampBatchID?.toHex() ??
      drives.find((drive) => kindOf(drive) === 'regular')?.batchID.toHex(),
  )
  // The stored name and icon over the URL's: any site can open this page with
  // a connected origin and name it whatever it likes.
  const appName = $derived(app?.appName ?? page?.appName ?? page?.appOrigin ?? '')
  const appIcon = $derived(app?.appIcon ?? page?.appIcon ?? `${page?.appOrigin}/favicon.ico`)
  /** The clock `connected` reads: not reactive, so `save` sets it again. */
  let now = $state(Date.now())
  const connected = $derived(grantableOnRequest(app, now))
  const showAllCheckbox = $derived(requesting ? requested === 'all' : app?.drives === 'all')
  // Write access is shown once data sharing is on, as designed.
  const switches = $derived(
    switchesToShow(page?.permissions).filter(
      (name) => name !== 'writeAccess' || sharing.dataSharing,
    ),
  )
  const pinned = $derived(app ? pinnedDifferently(app, account?.settings) : [])

  /** Why the page cannot grant anything, if it cannot. */
  const refusal = $derived.by(() => {
    if (framed) return 'This page cannot be shown inside another site.'
    if (!page) return undefined
    if (!account) return 'This account is not on this device.'
    if (account.isSignedOut) return `Sign in to ${account.name} first.`
    // A request grants to a live session only. Editing is for the Apps tab,
    // which lists disconnected apps too, so a grant can be trimmed before the
    // app reconnects.
    if (!app || (requesting && !connected)) {
      return `${appName} is not connected to ${account.name}.`
    }
    return undefined
  })

  onMount(() => {
    framed = window.top !== window
    if (framed) return
    page = parsePermissionsHash(window.location.hash)
    if (!page) {
      goto(resolve(routes.ROOT))
      return
    }
    if (requesting) {
      rows = Array.isArray(requested) ? requestRows(requested) : []
    } else if (app) {
      rows = editRows(app.drives, drives, defaultBatchHex)
      allTicked = app.drives === 'all'
    }
    initialSharing = switchValues(app, account?.settings)
    sharing = { ...initialSharing }
  })

  /** "Use account default": the switch follows the account again on save. */
  function useDefault(name: PermissionName) {
    sharing[name] = sharingDefault(account?.settings, name)
    if (!resets.includes(name)) resets.push(name)
  }

  function optionsFor(index: number): SelectOption[] {
    const choices = rowChoices(rows, index, drives).map((drive) => ({
      value: drive.batchID.toHex(),
      label:
        driveDisplayName(drive) + (drive.batchID.toHex() === defaultBatchHex ? ' (default)' : ''),
    }))
    // A granted drive this device has no record of (edit mode): keep it
    // selectable, so saving keeps it and "None" is the only way to drop it.
    const chosen = rows[index].chosen
    if (chosen !== '' && !choices.some((choice) => choice.value === chosen)) {
      choices.unshift({ value: chosen, label: unknownDriveLabel(chosen) })
    }
    return [
      ...(rows[index].optional
        ? [{ value: '', label: requesting ? 'Please select drive' : 'None' }]
        : []),
      ...choices,
      { value: ADD_NEW_DRIVE, label: 'Add new drive…' },
    ]
  }

  function choose(index: number, value: string) {
    if (value === ADD_NEW_DRIVE) {
      batchesBeforeAdd = new Set(drives.map((drive) => drive.batchID.toHex()))
      addingFor = index
    } else {
      rows[index].chosen = value
    }
  }

  function closeAddDialog() {
    addingFor = undefined
    selectEpoch += 1
  }

  function onDriveAdded(message: string) {
    toastStore.show(message)
    const added = drives.find((drive) => !batchesBeforeAdd.has(drive.batchID.toHex()))
    if (addingFor !== undefined && added) rows[addingFor].chosen = added.batchID.toHex()
  }

  async function save() {
    // A popup can sit open past the connection's end.
    now = Date.now()
    if (!page || !account || !app || refusal || saving) return
    const current = app.drives
    const grant = !requesting
      ? grantAfterEdit(current, rows, allTicked, defaultBatchHex)
      : requested === 'all'
        ? allTicked
          ? 'all'
          : current
        : grantAfterRequest(current, defaultBatchHex, rowsGrant(rows))
    const grantChanged = !sameGrant(grant, current)
    const sharingPatch = sharingAfterSave(initialSharing, sharing, resets, account.settings)
    const changed = grantChanged || Object.keys(sharingPatch).length > 0
    if (changed) {
      account.setAppPermissions(page.appOrigin, {
        ...(grantChanged ? { drives: grant } : {}),
        ...sharingPatch,
      })
    }

    if (!requesting) {
      toastStore.show('Permissions saved')
      goto(resolve(routes.ROOT))
      return
    }
    // A partitioned session cannot see this write: hand it the account as
    // the bus would. The collections are Svelte proxies, which structured
    // clone rejects, so the wire shape goes through JSON.
    if (page.challenge && window.opener) {
      const message = {
        type: 'grantUpdated',
        appOrigin: page.appOrigin,
        challenge: page.challenge,
        delta: { type: 'account-delta', snapshot: accountDeltaSnapshot(account.toSyncedRecord()) },
      }
      window.opener.postMessage(JSON.parse(JSON.stringify(message)), window.location.origin)
    } else if (page.handOverViaBus && changed) {
      // Opened by the page while the session is partitioned: the bus is the
      // only way back, and closing now would take the delta with the window.
      // Nothing changed, nothing to carry: the page closes at once.
      saving = true
      await accountBusStore.publishBeforeClose(account.toSyncedRecord())
    }
    window.close()
  }
</script>

{#if framed}
  <p class="text-muted-foreground p-8 text-center text-sm">{refusal}</p>
{:else if page}
  <div class="flex min-h-svh flex-col">
    <AppHeader />
    <main class="flex w-full flex-1 flex-col items-center justify-center px-4 pb-24 sm:px-8">
      <div class="flex w-full max-w-96 flex-col items-center gap-8">
        <div class="flex w-full flex-col items-center gap-2 text-center">
          <AppIcon src={appIcon} name={appName} size={ICON_SIZE} />
          <h1 class="text-lg leading-tight font-bold">Permissions for {appName}</h1>
          <p class="text-sm">{page.appOrigin}</p>
        </div>

        {#if refusal}
          <p class="text-muted-foreground text-center text-sm">{refusal}</p>
        {:else}
          <div class="flex w-full flex-col gap-4">
            {#if showAllCheckbox}
              <label class="flex w-full items-start gap-2 text-sm">
                <input type="checkbox" bind:checked={allTicked} class="mt-0.5 size-4 shrink-0" />
                <span class="flex flex-col gap-1">
                  <span class="font-medium">Grant this app full drive access</span>
                  <span class="text-muted-foreground">
                    Access to all drives in your account, including any drives you add in the
                    future. Only grant this if you trust the app developer.
                  </span>
                </span>
              </label>
            {/if}
            {#each rows as row, index (index)}
              <div class="flex w-full flex-col gap-2">
                <p class="text-sm">{row.kind === 'scratch' ? 'Scratch drive' : 'Drive'}</p>
                {#key selectEpoch}
                  <Select
                    options={optionsFor(index)}
                    value={row.chosen}
                    onchange={(value) => choose(index, value)}
                  />
                {/key}
                <p class="text-muted-foreground text-sm">{row.description}</p>
              </div>
            {/each}
            {#if switches.length > 0 && (rows.length > 0 || showAllCheckbox)}
              <div class="bg-border h-px w-full"></div>
            {/if}
            {#each switches as name (name)}
              <div class="flex w-full items-start gap-3">
                <Switch bind:checked={sharing[name]} aria-label={SWITCH_COPY[name].label} />
                <div class="flex flex-col gap-1 text-sm">
                  <span class="font-medium">{SWITCH_COPY[name].label}</span>
                  <span class="text-muted-foreground">{SWITCH_COPY[name].description}</span>
                  {#if !requesting && pinned.includes(name) && !resets.includes(name)}
                    <span class="text-muted-foreground">
                      Account default: {sharingDefault(account?.settings, name) ? 'on' : 'off'} ·
                      <button type="button" class="underline" onclick={() => useDefault(name)}>
                        Use account default
                      </button>
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
            <Button class="w-full" onclick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save permissions'}
            </Button>
          </div>
        {/if}
      </div>
    </main>

    {#if account && addingFor !== undefined}
      <DriveAddDialog
        {account}
        kind={rows[addingFor].kind}
        onClose={closeAddDialog}
        onAdded={onDriveAdded}
      />
    {/if}
  </div>
{/if}
