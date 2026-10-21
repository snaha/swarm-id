<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  Every permissions flow in one place (#862, #885): what the next connect asks
  for, what the app holds now, and a request made while connected.
-->
<script lang="ts">
  import type { DriveKind, Permissions } from '@snaha/swarm-id'

  import AsyncButton from '$lib/components/async-button.svelte'
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from '$lib/components/ui/card'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Label } from '$lib/components/ui/label'
  import {
    DRIVE_REQUEST_PRESETS,
    type DriveRequestPreset,
    clientStore,
  } from '$lib/stores/client.svelte'

  /** What a later request asks for, ticked here. */
  let askDataSharing = $state(false)
  let askWriteAccess = $state(false)
  let askAll = $state(false)
  let askRegular = $state(false)
  let askScratch = $state(false)
  let lastResult = $state<string | undefined>(undefined)

  const request = $derived.by((): Permissions | undefined => {
    const drives = [
      ...(askRegular ? [{ kind: 'regular' as DriveKind }] : []),
      ...(askScratch ? [{ kind: 'scratch' as DriveKind }] : []),
    ]
    const permissions: Permissions = {
      ...(askAll ? { drives: 'all' } : drives.length > 0 && { drives }),
      ...(askDataSharing && { dataSharing: true }),
      ...(askWriteAccess && { writeAccess: true }),
    }
    return Object.keys(permissions).length > 0 ? permissions : undefined
  })

  function onOff(value: boolean | undefined): string {
    return value === undefined ? '—' : value ? 'on' : 'off'
  }

  async function requestNow() {
    if (!request) return
    const held = await clientStore.requestPermissions(request)
    lastResult = held
      ? `Data sharing ${onOff(held.dataSharing)}, write access ${onOff(held.writeAccess)}; drives: ${
          clientStore.drives
            .map((drive) => `${drive.kind} ${drive.batchID.slice(0, 8)}…`)
            .join(', ') || 'none'
        }`
      : 'The request failed — see the console'
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold text-foreground">Permissions</h1>
    <p class="text-sm text-muted-foreground">
      What the app asks for at connect, what it holds, and asking for more while connected.
    </p>
  </div>

  <Card>
    <CardHeader>
      <CardTitle>Ask at connect</CardTitle>
      <CardDescription>
        Applied on the next connect. Drives are asked as rows on the connect screen; a sharing
        switch is asked there only when it is not already on for this app.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <label class="block text-sm text-muted-foreground">
        Request drives
        <select
          class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={clientStore.driveRequestPreset}
          onchange={(event) =>
            (clientStore.driveRequestPreset = event.currentTarget.value as DriveRequestPreset)}
        >
          {#each Object.entries(DRIVE_REQUEST_PRESETS) as [key, preset] (key)}
            <option value={key}>{preset.label}</option>
          {/each}
        </select>
      </label>
      <div class="flex items-center gap-2">
        <Checkbox
          id="connect-data-sharing"
          checked={clientStore.sharingRequest.dataSharing}
          onchange={(checked) =>
            (clientStore.sharingRequest = { ...clientStore.sharingRequest, dataSharing: checked })}
        />
        <Label for="connect-data-sharing" class="cursor-pointer text-sm">Data sharing</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox
          id="connect-write-access"
          checked={clientStore.sharingRequest.writeAccess}
          onchange={(checked) =>
            (clientStore.sharingRequest = { ...clientStore.sharingRequest, writeAccess: checked })}
        />
        <Label for="connect-write-access" class="cursor-pointer text-sm">Write access</Label>
      </div>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>What the app holds</CardTitle>
      <CardDescription>
        From <code class="bg-muted px-1 rounded">connectionInfo.permissions</code> and
        <code class="bg-muted px-1 rounded">getDrives()</code>; changes the user makes in Swarm ID
        arrive live.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-2 text-sm">
      {#if clientStore.authenticated}
        <p>Data sharing: {onOff(clientStore.permissions?.dataSharing)}</p>
        <p>Write access: {onOff(clientStore.permissions?.writeAccess)}</p>
        <p>
          Sharing key: {clientStore.identity?.sharingPublicKey
            ? 'available'
            : 'withheld (data sharing is off)'}
        </p>
        <p>
          Drives: {clientStore.drives
            .map(
              (drive) =>
                `${drive.kind} ${drive.batchID.slice(0, 8)}…${drive.primary ? ' (primary)' : ''}`,
            )
            .join(', ') || 'none'}
        </p>
      {:else}
        <p class="text-muted-foreground">Not connected.</p>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Ask now</CardTitle>
      <CardDescription>
        <code class="bg-muted px-1 rounded">requestPermissions()</code> opens the Permissions popup with
        what is ticked. Nothing opens when every switch asked for is already on and no drive was asked.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="flex items-center gap-2">
        <Checkbox id="ask-data-sharing" bind:checked={askDataSharing} />
        <Label for="ask-data-sharing" class="cursor-pointer text-sm">Data sharing</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox id="ask-write-access" bind:checked={askWriteAccess} />
        <Label for="ask-write-access" class="cursor-pointer text-sm">Write access</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox id="ask-all" bind:checked={askAll} />
        <Label for="ask-all" class="cursor-pointer text-sm">All drives</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox id="ask-regular" bind:checked={askRegular} disabled={askAll} />
        <Label for="ask-regular" class="cursor-pointer text-sm">A regular drive</Label>
      </div>
      <div class="flex items-center gap-2">
        <Checkbox id="ask-scratch" bind:checked={askScratch} disabled={askAll} />
        <Label for="ask-scratch" class="cursor-pointer text-sm">A scratch drive</Label>
      </div>
      <AsyncButton
        onclick={requestNow}
        disabled={!clientStore.authenticated || request === undefined}
        loadingText="Waiting for the popup…"
      >
        Request permissions
      </AsyncButton>
      {#if lastResult}
        <p class="text-sm text-muted-foreground">{lastResult}</p>
      {/if}
    </CardContent>
  </Card>
</div>
