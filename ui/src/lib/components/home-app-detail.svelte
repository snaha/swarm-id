<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  One app of the Apps tab (SwarmID-MVP, APPS, Frame 154): what it holds, each
  control applying as it is changed — a drive row (a drive set to "None" is
  taken away, unticking "all" falls back to the account default), the sharing
  switches (moving one pins it for this app; "Use account default" unpins
  it, #885) — and the two ways out, Disconnect and Revoke access.
  Not here yet: the design's per-app "Storage used" and "Keep app connected
  for" rows, which need data and a field the record does not have.
-->
<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import LogOut from '@lucide/svelte/icons/log-out'
  import X from '@lucide/svelte/icons/x'
  import type { ConnectedApp, PermissionName } from '@snaha/swarm-id/internal'

  import DrivePickerRows from '$lib/components/drive-picker-rows.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Switch } from '$lib/components/ui/switch'
  import { type PickerRow, kindOf } from '$lib/drive-request'
  import {
    PERMISSION_NAMES,
    SWITCH_COPY,
    editRows,
    grantAfterEdit,
    pinnedDifferently,
    sameGrant,
    sharingDefault,
    switchValues,
  } from '$lib/permissions-request'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    app: ConnectedApp
    onback: () => void
  }

  let { account, app, onback }: Props = $props()

  const drives = $derived(account.stamps)
  const defaultBatchHex = $derived(
    account.defaultPostageStampBatchID?.toHex() ??
      drives.find((drive) => kindOf(drive) === 'regular')?.batchID.toHex(),
  )
  const connected = $derived(app.connectedUntil !== undefined && app.connectedUntil > Date.now())
  const sharing = $derived(switchValues(app, account.settings))
  const pinned = $derived(pinnedDifferently(app, account.settings))
  const switches = $derived(
    PERMISSION_NAMES.filter((name) => name !== 'writeAccess' || sharing.dataSharing),
  )

  // Re-derived from the grant after each save; the picker edits the rows in place.
  let rows: PickerRow[] = $derived(editRows(app.drives, drives, defaultBatchHex))

  function saveDrives() {
    const grant = grantAfterEdit(app.drives, rows, app.drives === 'all', defaultBatchHex)
    if (sameGrant(grant, app.drives)) return
    account.setAppPermissions(app.appUrl, { drives: grant })
    toastStore.show('Permissions saved')
  }

  function setAll(ticked: boolean) {
    if (ticked) return
    account.setAppPermissions(app.appUrl, { drives: undefined })
    toastStore.show('Permissions saved')
  }

  function flip(name: PermissionName) {
    account.setAppPermissions(app.appUrl, { [name]: !sharing[name] })
  }

  function useDefault(name: PermissionName) {
    account.setAppPermissions(app.appUrl, { [name]: undefined })
  }

  function revoke() {
    account.removeApp(app.appUrl)
    onback()
  }
</script>

<div class="flex w-full flex-col gap-8">
  <div class="flex w-full items-center gap-2">
    <Button
      variant="outline"
      size="icon"
      aria-label="Back to apps"
      class="size-8 shrink-0 [&_svg]:size-4"
      onclick={onback}
    >
      <ChevronLeft />
    </Button>
    <p class="min-w-0 flex-1 truncate text-base font-bold">{app.appName}</p>
    <p class="text-muted-foreground truncate text-sm">{app.appUrl}</p>
  </div>

  <div class="flex w-full flex-col gap-4">
    {#if app.drives === 'all'}
      <label class="flex w-full items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked
          class="mt-0.5 size-4 shrink-0"
          onchange={(event) => setAll(event.currentTarget.checked)}
        />
        <span class="flex flex-col gap-1">
          <span class="font-medium">Grant this app full drive access</span>
          <span class="text-muted-foreground">
            Access to all drives in your account, including any drives you add in the future. Only
            grant this if you trust the app developer.
          </span>
        </span>
      </label>
    {:else}
      <DrivePickerRows {account} bind:rows emptyLabel="None" onchange={saveDrives} />
    {/if}

    <div class="bg-border h-px w-full"></div>

    {#each switches as name (name)}
      <div class="flex w-full items-start gap-3">
        <Switch
          checked={sharing[name]}
          aria-label={SWITCH_COPY[name].label}
          onclick={() => flip(name)}
        />
        <div class="flex flex-col gap-1 text-sm">
          <span class="font-medium">{SWITCH_COPY[name].label}</span>
          <span class="text-muted-foreground">{SWITCH_COPY[name].description}</span>
          {#if pinned.includes(name)}
            <span class="text-muted-foreground">
              Account default: {sharingDefault(account.settings, name) ? 'on' : 'off'} ·
              <button type="button" class="underline" onclick={() => useDefault(name)}>
                Use account default
              </button>
            </span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="flex w-full items-center justify-between gap-4">
    {#if connected}
      <Button variant="outline" onclick={() => account.disconnectApp(app.appUrl)}>
        <LogOut />
        Disconnect
      </Button>
    {:else}
      <span></span>
    {/if}
    <Button variant="destructive" onclick={revoke}>
      <X />
      Revoke access
    </Button>
  </div>
</div>
