<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { clientStore } from '$lib/stores/client.svelte'

  let expanded = $state(false)
</script>

<div class="space-y-2">
  <button
    onclick={() => (expanded = !expanded)}
    class="flex w-full items-center justify-between text-left rounded-md px-2.5 py-2 transition-colors hover:bg-accent"
  >
    <div class="flex items-center gap-1.5">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-muted-foreground shrink-0 transition-transform duration-200 {expanded
          ? 'rotate-90'
          : ''}"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Stamp</span>
    </div>
    {#if clientStore.stamp}
      <Badge
        variant={clientStore.stamp.usable ? 'success' : 'destructive'}
        class="text-xs px-2 py-0.5"
      >
        {clientStore.stamp.usable ? 'Usable' : 'Unusable'}
      </Badge>
    {:else if clientStore.uploadMode === 'subsidised'}
      <Badge variant="success" class="text-xs px-2 py-0.5">Subsidised</Badge>
    {:else}
      <Badge variant="outline" class="text-xs px-2 py-0.5 text-muted-foreground border-border"
        >N/A</Badge
      >
    {/if}
  </button>

  {#if clientStore.drives.length > 1}
    <label class="block pl-6 text-xs text-muted-foreground">
      Write to
      <select
        class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        value={clientStore.targetDriveId ?? ''}
        onchange={(event) => (clientStore.targetDriveId = event.currentTarget.value || undefined)}
      >
        <option value="">Primary drive</option>
        {#each clientStore.drives as drive (drive.driveId)}
          <option value={drive.driveId}>
            {drive.label} · {drive.kind}{drive.primary ? ' · primary' : ''}
          </option>
        {/each}
      </select>
    </label>
    <!-- One lane per drive: each drive's lease is its own (#882). -->
    {#each clientStore.drives as drive (drive.driveId)}
      <div class="text-xs text-muted-foreground pl-6">
        Lane on {drive.label}: {drive.partition ?? 'Inactive'}
      </div>
    {/each}
  {/if}

  {#if clientStore.stamp}
    <div class="text-xs text-muted-foreground pl-6">TTL: {clientStore.stamp.ttl}</div>
    <div class="text-xs text-muted-foreground pl-6">
      Partition: {clientStore.partition === undefined ? 'Inactive' : clientStore.partition}
    </div>
  {/if}

  {#if expanded}
    {#if clientStore.stamp}
      <dl class="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1 text-xs pl-6">
        <dt class="text-muted-foreground">Drive</dt>
        <dd class="text-foreground break-all">{clientStore.stamp.label}</dd>
        <dt class="text-muted-foreground">Drive ID</dt>
        <dd class="font-mono text-foreground break-all">{clientStore.stamp.driveId}</dd>
        <dt class="text-muted-foreground">Utilization</dt>
        <dd class="font-mono text-foreground">{clientStore.stamp.utilization}%</dd>
        <dt class="text-muted-foreground">Depth</dt>
        <dd class="font-mono text-foreground">{clientStore.stamp.depth}</dd>
      </dl>
      <!-- The batch id is the user's, not the app's (#746): the proxy hands it out only under "Key export". -->
      <button
        type="button"
        class="mt-1 pl-6 text-xs text-muted-foreground underline"
        onclick={() => clientStore.revealPrimaryBatch()}
      >
        Reveal postage batch (needs Key export)
      </button>
    {:else if clientStore.uploadMode === 'subsidised'}
      <div class="text-xs text-muted-foreground pl-6">Using public gateway for uploads</div>
    {/if}
  {/if}
</div>
