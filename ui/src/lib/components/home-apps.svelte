<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  The Apps tab (SwarmID-MVP, APPS, Frame 31): the account-wide settings, then
  one row per connected app opening its own page (Frame 154, `home-app-detail`),
  deep-linkable as `#apps/<origin>`.
-->
<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right'

  import { replaceState } from '$app/navigation'
  import { page } from '$app/state'

  import AppIcon from '$lib/components/app-icon.svelte'
  import HomeAppDetail from '$lib/components/home-app-detail.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Select } from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { CONNECTION_DAYS_OPTIONS, msToDays } from '$lib/duration'
  import { customised, sharingDefault } from '$lib/permissions-request'
  import type { Account } from '$lib/types'

  const DEFAULT_CONNECTION_DAYS = 30

  interface Props {
    account: Account
    /** From the URL hash (`#apps/<origin>`): the app to open. */
    target?: string[]
  }

  let { account, target = [] }: Props = $props()

  let connectionDays = $derived(
    String(
      account.settings?.appSessionDuration !== undefined
        ? msToDays(account.settings.appSessionDuration)
        : DEFAULT_CONNECTION_DAYS,
    ),
  )
  // Revoked tombstones stay in the record for sync; only show live entries.
  const activeApps = $derived(account.activeApps)
  // The account-wide sharing switches (#885), on unless turned off here;
  // write access is shown once data sharing is on, as on the app's own page.
  const dataSharing = $derived(sharingDefault(account.settings, 'dataSharing'))
  const writeAccess = $derived(sharingDefault(account.settings, 'writeAccess'))

  /** The open app's origin: from the hash, then the row clicked or "Back". */
  let openUrl = $derived(target[0] ? decodeURIComponent(target[0]) : undefined)
  const openApp = $derived(activeApps.find((app) => app.appUrl === openUrl))

  function open(appUrl: string | undefined) {
    openUrl = appUrl
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- hash only, same page
    replaceState(appUrl ? `#apps/${encodeURIComponent(appUrl)}` : '#apps', page.state)
  }

  function isConnected(connectedUntil: number | undefined): boolean {
    return connectedUntil !== undefined && connectedUntil > Date.now()
  }
</script>

{#if openApp}
  <HomeAppDetail {account} app={openApp} onback={() => open(undefined)} />
{:else}
  <div class="flex w-full flex-col gap-4">
    <div class="flex w-full items-center justify-between gap-4">
      <p class="text-sm">Keep apps connected for</p>
      <Select
        options={CONNECTION_DAYS_OPTIONS}
        bind:value={connectionDays}
        class="w-70"
        onchange={(value) => account.setAppConnectionDays(Number(value))}
      />
    </div>

    <div class="flex w-full items-start justify-between gap-4">
      <div class="flex flex-col gap-1 text-sm">
        <p>Data sharing</p>
        <p class="text-muted-foreground">Allow apps to access data shared by other apps</p>
      </div>
      <Switch
        checked={dataSharing}
        aria-label="Data sharing"
        onclick={() => account.setSharingDefault('dataSharing', !dataSharing)}
      />
    </div>
    {#if dataSharing}
      <div class="flex w-full items-start justify-between gap-4">
        <div class="flex flex-col gap-1 text-sm">
          <p>Write access</p>
          <p class="text-muted-foreground">Allow apps to share data with other apps</p>
        </div>
        <Switch
          checked={writeAccess}
          aria-label="Write access"
          onclick={() => account.setSharingDefault('writeAccess', !writeAccess)}
        />
      </div>
    {/if}

    <div class="bg-border h-px w-full"></div>

    {#if activeApps.length === 0}
      <p class="text-muted-foreground py-8 text-center text-sm">No connected apps yet.</p>
    {:else}
      <!-- Frame 31's Item: 10px vertical padding and gaps, a 40px rounded-sm
           icon, 16px name line over a 20px URL line, badges, and a 32px icon
           slot with a 16px chevron; a separator between rows and after the last. -->
      <div class="flex w-full flex-col">
        {#each activeApps as app (app.appUrl)}
          <button
            type="button"
            class="border-border flex w-full cursor-pointer items-center gap-2.5 border-b py-2.5 text-left"
            onclick={() => open(app.appUrl)}
          >
            <AppIcon src={app.appIcon} name={app.appName} size={40} class="rounded-sm" />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <p class="truncate text-sm leading-4 font-medium">{app.appName}</p>
              <p class="text-muted-foreground truncate text-sm leading-5">{app.appUrl}</p>
            </div>
            {#if customised(app, account.settings)}
              <Badge variant="outline">Custom permissions</Badge>
            {/if}
            {#if !isConnected(app.connectedUntil)}
              <Badge>Disconnected</Badge>
            {/if}
            <span class="flex size-8 shrink-0 items-center justify-center">
              <ChevronRight class="size-4" />
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
