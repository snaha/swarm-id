<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  "Permissions for <app>" (#711, #885; SwarmID-MVP, section PERMISSIONS): an
  app's request, in a popup. Only what it asked for is shown — a drive row
  per drive, empty; the sharing switches not already on, off — and saving
  with nothing chosen grants nothing. The drives chosen are added to what
  the app already holds; a switch turned on is pinned for this app.
  Editing everything an app holds is the Apps tab's own page
  (`home-app-detail`).
  A grant is a write to the account record, so nothing is unlocked here —
  which is why the page refuses to render inside a frame, and grants only to
  an app with a live connection. The grant reaches the app's live session as
  a storage event or an account-bus delta; a partitioned session that opened
  this popup is handed it directly, and one whose popup the page had to open
  instead waits for the bus delta to leave before closing.
-->
<script lang="ts">
  import { onMount } from 'svelte'

  import {
    type AppPermissions,
    type PermissionName,
    accountDeltaSnapshot,
    effectivePermissions,
  } from '@snaha/swarm-id/internal'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import AppIcon from '$lib/components/app-icon.svelte'
  import DrivePickerRows from '$lib/components/drive-picker-rows.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Switch } from '$lib/components/ui/switch'
  import { type PickerRow, kindOf, rowsGrant } from '$lib/drive-request'
  import {
    type PermissionsPageRequest,
    SWITCH_COPY,
    askedPatch,
    grantAfterRequest,
    grantableOnRequest,
    parsePermissionsHash,
    requestRows,
    sameGrant,
    switchesToAsk,
  } from '$lib/permissions-request'
  import routes from '$lib/routes'
  import { accountBusStore } from '$lib/stores/account-bus'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  const ICON_SIZE = 48

  let page = $state<PermissionsPageRequest | undefined>(undefined)
  let rows = $state<PickerRow[]>([])
  let allTicked = $state(false)
  /** The sharing switches: what was in effect at load, and what they show now. */
  let initialSharing = $state<AppPermissions>({
    dataSharing: true,
    writeAccess: true,
    revealSecrets: false,
  })
  let sharing = $state<AppPermissions>({
    dataSharing: true,
    writeAccess: true,
    revealSecrets: false,
  })

  /** Flip a switch; write access cannot outlive data sharing. */
  function flip(name: PermissionName) {
    sharing[name] = !sharing[name]
    if (name === 'dataSharing' && !sharing.dataSharing) sharing.writeAccess = false
  }
  let saving = $state(false)

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
  // Write access stays on screen while data sharing is off, disabled: both
  // asked for means both shown, and one enables the other.
  const switches = $derived(switchesToAsk(page?.permissions, initialSharing))

  /** Why the page cannot grant anything, if it cannot. */
  const refusal = $derived.by(() => {
    if (!page) return undefined
    if (!account) return 'This account is not on this device.'
    if (account.isSignedOut) return `Sign in to ${account.name} first.`
    if (!app || !connected) return `${appName} is not connected to ${account.name}.`
    return undefined
  })

  onMount(() => {
    page = parsePermissionsHash(window.location.hash)
    if (!page || page.permissions === undefined) {
      goto(resolve(routes.ROOT))
      return
    }
    rows = Array.isArray(requested) ? requestRows(requested) : []
    initialSharing = effectivePermissions(app, account?.settings)
    sharing = { ...initialSharing }
  })

  async function save() {
    // A popup can sit open past the connection's end.
    now = Date.now()
    if (!page || !account || !app || refusal || saving) return
    const current = app.drives
    const grant =
      requested === 'all'
        ? allTicked
          ? 'all'
          : current
        : grantAfterRequest(current, defaultBatchHex, rowsGrant(rows))
    const grantChanged = !sameGrant(grant, current)
    const sharingPatch = askedPatch(initialSharing, sharing, switches)
    const changed = grantChanged || Object.keys(sharingPatch).length > 0
    if (changed) {
      account.setAppPermissions(page.appOrigin, {
        ...(grantChanged ? { drives: grant } : {}),
        ...sharingPatch,
      })
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

{#if page}
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
        {:else if account}
          <div class="flex w-full flex-col gap-4">
            {#if requested === 'all'}
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
            <DrivePickerRows {account} bind:rows emptyLabel="Please select drive" />
            {#if switches.length > 0 && (rows.length > 0 || requested === 'all')}
              <div class="bg-border h-px w-full"></div>
            {/if}
            {#each switches as name (name)}
              <div class="flex w-full items-start gap-3">
                <Switch
                  checked={sharing[name]}
                  disabled={name === 'writeAccess' && !sharing.dataSharing}
                  aria-label={SWITCH_COPY[name].label}
                  onclick={() => flip(name)}
                />
                <div class="flex flex-col gap-1 text-sm">
                  <span class="font-medium">{SWITCH_COPY[name].label}</span>
                  <span class="text-muted-foreground">{SWITCH_COPY[name].description}</span>
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
  </div>
{/if}
