<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  One app of the Apps tab (SwarmID-MVP, APPS, Frame 154): what it holds, each
  control applying as it is changed — a drive row (a drive set to "None" is
  taken away, unticking "all" falls back to the account default; either
  waits for a typed confirmation when it takes a drive away, #925), the sharing
  switches (moving one pins it for this app, even to the value the account
  default has; "Use account default" unpins it, #885) — and the two ways out,
  Disconnect and Revoke access. Every control grants on the spot; like every
  route but `/proxy`, it refuses to render framed (`routes/+layout.svelte`).
  "Keep app connected for" is the app's own session length, applied at its
  next connect (a running session keeps the deadline it was given), and
  counts as custom like a pinned switch. Not here yet: the design's per-app
  "Storage used", which needs data the record does not have.
-->
<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import LogOut from '@lucide/svelte/icons/log-out'
  import X from '@lucide/svelte/icons/x'
  import {
    type ConnectedApp,
    type PermissionName,
    appSessionDuration,
    effectivePermissions,
    sharingDefault,
  } from '@snaha/swarm-id/internal'

  import AppDrivesDialog from '$lib/components/app-drives-dialog.svelte'
  import DrivePickerRows from '$lib/components/drive-picker-rows.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { type PickerRow, kindOf } from '$lib/drive-request'
  import { driveDisplayName } from '$lib/drives'
  import { CONNECTION_DAYS_OPTIONS, daysToMs, msToDays } from '$lib/duration'
  import {
    type Grant,
    PERMISSION_NAMES,
    SWITCH_COPY,
    askedPatch,
    drivesTakenAway,
    editRows,
    grantAfterEdit,
    grantAfterRequest,
    pinned,
    sameGrant,
    unknownDriveLabel,
    writableBatches,
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
  const sharing = $derived(effectivePermissions(app, account.settings))
  const pinnedSwitches = $derived(pinned(app, account.settings))
  const switches = $derived(
    PERMISSION_NAMES.filter((name) => name !== 'writeAccess' || sharing.dataSharing),
  )
  const defaultDays = $derived(msToDays(appSessionDuration(account.settings)))
  const connectionDays = $derived(msToDays(appSessionDuration(account.settings, app)))
  // A pin equal to the default is a pin, as with the switches.
  const customDuration = $derived(app.sessionDuration !== undefined)

  // What a grant with no list resolves to in the lib: the explicit default
  // only, never the picker's first-regular-drive fallback.
  const explicitDefaultHex = $derived(account.defaultPostageStampBatchID?.toHex())

  // An edit that takes drives away waits for the user to confirm it (#925).
  // `before` is the grant it was proposed against, so a change that lands
  // meanwhile (another device, the permissions popup) is not overwritten;
  // `rows` is the edit, shown while it waits so a sync cannot reset it.
  let pending = $state<
    | {
        before: Grant
        grant: Grant
        rows: PickerRow[]
        takenAway: string[]
        keepsAny: boolean
        shrinks: boolean
      }
    | undefined
  >(undefined)

  // Re-derived from the grant after each save, or a cancel; the picker edits
  // the rows in place.
  let rows: PickerRow[] = $derived(pending?.rows ?? editRows(app.drives, drives, defaultBatchHex))

  function nameOf(hex: string): string {
    const drive = drives.find((candidate) => candidate.batchID.toHex() === hex)
    return drive ? driveDisplayName(drive) : unknownDriveLabel(hex)
  }

  function applyDrives(grant: Grant) {
    account.setAppPermissions(app.appUrl, { drives: grant })
    toastStore.show('Permissions saved')
  }

  /** Apply `grant` at once, or ask first when it takes drives away */
  function proposeDrives(grant: Grant) {
    // Tombstones included, so dropping a deleted drive is not asked about.
    const stamps = account.postageStamps
    const takenAway = drivesTakenAway(app.drives, grant, stamps, explicitDefaultHex)
    if (takenAway.length === 0) {
      applyDrives(grant)
      return
    }
    pending = {
      before: app.drives,
      grant,
      rows: rows.map((row) => ({ ...row })),
      takenAway: takenAway.map(nameOf),
      keepsAny: writableBatches(grant, stamps, explicitDefaultHex).length > 0,
      // A swap leaves as many rows, so the drive can be picked again here;
      // only an edit that leaves fewer cannot be undone from this page.
      shrinks:
        writableBatches(grant, stamps, explicitDefaultHex).length <
        writableBatches(app.drives, stamps, explicitDefaultHex).length,
    }
  }

  function confirmPending() {
    if (!pending) return
    if (sameGrant(pending.before, app.drives)) {
      applyDrives(pending.grant)
    } else {
      toastStore.show("This app's drives changed meanwhile; nothing was saved")
    }
    pending = undefined
  }

  // A drive made through a row's "Add new drive…" joins the grant rather
  // than replacing that row's drive: the user bought it for this app, and
  // was not asking to take the other away.
  function saveDrives(added?: string) {
    const grant =
      added === undefined
        ? grantAfterEdit(app.drives, rows, app.drives === 'all', defaultBatchHex)
        : grantAfterRequest(app.drives, explicitDefaultHex, [added])
    if (sameGrant(grant, app.drives)) return
    proposeDrives(grant)
  }

  // The popup's rule: write access is hidden while data sharing is off, so
  // turning data sharing on pins it off rather than granting it unseen.
  function flip(name: PermissionName) {
    const shown = { ...sharing, [name]: !sharing[name] }
    account.setAppPermissions(app.appUrl, askedPatch(sharing, shown, [name]))
  }

  function useDefault(name: PermissionName) {
    account.setAppPermissions(app.appUrl, { [name]: undefined })
  }

  function setConnectionDays(days: number | undefined) {
    account.setAppPermissions(app.appUrl, {
      sessionDuration: days === undefined ? undefined : daysToMs(days),
    })
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
          checked={pending === undefined}
          class="mt-0.5 size-4 shrink-0"
          onchange={(event) => {
            if (!event.currentTarget.checked) proposeDrives(undefined)
          }}
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
          {#if pinnedSwitches.includes(name)}
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

    <div class="bg-border h-px w-full"></div>

    <div class="flex w-full items-center justify-between gap-4">
      <div class="flex flex-col gap-1 text-sm">
        <p>Keep app connected for</p>
        {#if customDuration}
          <p class="text-muted-foreground">
            Account default: {defaultDays} days ·
            <button type="button" class="underline" onclick={() => setConnectionDays(undefined)}>
              Use account default
            </button>
          </p>
        {/if}
      </div>
      <Select
        options={CONNECTION_DAYS_OPTIONS}
        value={String(connectionDays)}
        class="w-70"
        aria-label="Keep app connected for"
        onchange={(value) => setConnectionDays(Number(value))}
      />
    </div>
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

{#if pending}
  <AppDrivesDialog
    appName={app.appName}
    takenAway={pending.takenAway}
    keepsAny={pending.keepsAny}
    shrinks={pending.shrinks}
    onConfirm={confirmPending}
    onCancel={() => (pending = undefined)}
  />
{/if}
