<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { Bee } from '@ethersphere/bee-js'
  import CircleCheckBig from '@lucide/svelte/icons/circle-check-big'
  import Laptop from '@lucide/svelte/icons/laptop'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import {
    type Account,
    PartitionLease,
    type PartitionLeaseStateSnapshot,
    deriveSwarmEncryptionKey,
    getOrCreateDeviceId,
    hexToUint8Array,
    leaseCacheStorageKey,
  } from '@snaha/swarm-id'

  import { browser } from '$app/environment'

  import CopyButton from '$lib/components/copy-button.svelte'
  import { Button } from '$lib/components/ui/button'
  import { refreshAccountFromSwarm } from '$lib/dev/refresh-account-from-swarm'
  import { syncStore } from '$lib/dev/sync.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

  const { account }: { account: Account } = $props()

  // Re-read the shared lease cache this often so the self row picks up the
  // proxy's per-tick `leasedUntil` advances even when `storage` events don't
  // cross the iframe/tab boundary.
  const LEASE_CACHE_POLL_MS = 3_000

  const thisDeviceId = browser ? getOrCreateDeviceId() : undefined

  const hasPostageBatch = $derived(!!account.defaultPostageStampBatchID)

  // Refresh state — pull the snapshot from Swarm so peers added on other
  // browsers show up here.
  let refreshing = $state(false)
  let refreshedAt = $state<number | undefined>(undefined)
  let refreshError = $state<string | undefined>(undefined)
  // True when the backup feed has no reachable entry yet (e.g. the prior
  // backup expired with an old batch and the republish hasn't landed). Not
  // an error — drives an informative note + "Publish backup now" action.
  let noBackup = $state(false)
  let publishing = $state(false)
  // PEER active state, read through the PartitionLease model (lock SOCs on
  // Swarm — the cross-device source of truth). Other machines don't share
  // this tab's localStorage, so peers can only be observed via Swarm.
  // Best-effort: empty when the Bee node can't serve the lock SOC chunk.
  let holders = $state<{ partition: number; deviceId: string; leasedUntil: number }[]>([])

  // SELF active state, read from the proxy-written localStorage lease cache
  // (`swarm-id-lease-v2:<accountId>`). Shared across same-origin tabs, so it
  // reflects the demo iframe's held partition without a Swarm read (which is
  // currently 500ing). The proxy is the sole writer; refreshed ~every 10 s.
  let leaseCache = $state<PartitionLeaseStateSnapshot | undefined>(undefined)

  $effect(() => {
    if (!browser) return
    const key = leaseCacheStorageKey(account.id.toHex())
    const read = () => {
      const raw = localStorage.getItem(key)
      leaseCache = raw ? (JSON.parse(raw) as PartitionLeaseStateSnapshot) : undefined
    }
    read()
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) read()
    }
    window.addEventListener('storage', onStorage)
    // `storage` events don't reliably cross the iframe/tab boundary, so also
    // poll the cache to pick up the proxy's per-tick `leasedUntil` advances.
    const poll = setInterval(read, LEASE_CACHE_POLL_MS)
    return () => {
      window.removeEventListener('storage', onStorage)
      clearInterval(poll)
    }
  })

  async function doRefresh() {
    if (refreshing) return
    refreshing = true
    refreshError = undefined
    noBackup = false
    try {
      const result = await refreshAccountFromSwarm(account.id.toHex())
      if (result.ok) {
        refreshedAt = result.refreshedAt
      } else if (result.kind === 'no-backup') {
        noBackup = true
      } else {
        refreshError = result.error
      }
      // Always probe the lock SOCs even if the snapshot refresh failed —
      // they're an independent source of truth for the active-state badge.
      // Build a read-only PartitionLease and read its holders — the single
      // in-code lease model (no parallel holder variable).
      const partitionCount = account.partitionCount ?? 1
      if (partitionCount > 1 && account.derivationKey) {
        try {
          const bee = new Bee(networkSettingsStore.beeNodeUrl)
          const swarmKeyHex = await deriveSwarmEncryptionKey(account.derivationKey)
          const lease = await PartitionLease.fromSwarmEncryptionKey({
            bee,
            deviceId: thisDeviceId ?? '',
            swarmEncryptionKey: hexToUint8Array(swarmKeyHex),
          })
          await lease.refreshFromSwarm(partitionCount)
          holders = lease.getHolders()
        } catch (err) {
          console.warn('[devices] reading lock SOCs failed:', err)
        }
      } else {
        holders = []
      }
    } finally {
      refreshing = false
    }
  }

  // Republish the account snapshot to Swarm with the current default
  // stamp, then re-read. Used when the backup is missing (e.g. after a
  // batch swap). Best-effort: if the account isn't active, syncAccount
  // refuses and we stay in the no-backup state — no worse than before.
  async function doPublish() {
    if (publishing) return
    publishing = true
    try {
      await syncStore.syncAccount(account.id.toHex())
    } catch (err) {
      console.warn('[devices] publish backup failed:', err)
    } finally {
      publishing = false
    }
    await doRefresh()
  }

  // Refresh exactly once when the component mounts. No $effect — that
  // re-fires whenever any tracked dependency changes (which happens every
  // time `applyRefreshed` mutates the account), producing a loop.
  // onMount runs after initial render with no reactive subscriptions, so
  // it fires once per fresh mount and never again. Re-mounting the panel
  // (e.g. switching the selected account via {#key}) re-fires onMount —
  // that's how "re-visit to refresh" still works.
  onMount(() => {
    if (browser) void doRefresh()
  })

  let tick = $state(0)
  $effect(() => {
    if (!browser) return
    // Re-render the relative timestamp every 30 s.
    const timer = setInterval(() => (tick = tick + 1), 30_000)
    return () => clearInterval(timer)
  })

  function formatRelative(ms: number): string {
    void tick // depend on tick so the formatted string stays fresh
    const ago = Date.now() - ms
    if (ago < 5_000) return 'just now'
    if (ago < 60_000) return `${Math.floor(ago / 1_000)}s ago`
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
    return `${Math.floor(ago / 3_600_000)}h ago`
  }

  // Debug helper: is a lease still live, relative to now?
  function leaseLiveness(leasedUntil: number): string {
    void tick // re-evaluate as time passes
    const now = Date.now()
    return leasedUntil > now
      ? `LIVE (now ${formatDateTime(now)})`
      : `EXPIRED ${Math.floor((now - leasedUntil) / 1000)}s ago (now ${formatDateTime(now)})`
  }

  const deviceRows = $derived.by(() => {
    // `tick` so the self lease-expiry check re-evaluates over time.
    void tick
    const now = Date.now()
    return (account.devices ?? []).map((d) => {
      const isThis = d.deviceId === thisDeviceId
      if (isThis) {
        // Self: read from the shared localStorage lease cache (proxy is the
        // sole writer). The cache key is per-account and machine-local, so a
        // live `self` lease in it means THIS machine holds that partition —
        // independent of the device-id string stored inside (the proxy's
        // captured id can differ from this tab's id even when the value is
        // shared). So don't gate on the inner deviceId; just check liveness.
        const self = leaseCache?.self
        const active = self !== undefined && self.leasedUntil > now
        return {
          ...d,
          isThis: true,
          isActive: active,
          partition: active ? self!.partition : undefined,
        }
      }
      // Peers: cross-device, only observable via the lock SOC (Swarm).
      const holderEntry = holders.find((h) => h.deviceId === d.deviceId)
      return {
        ...d,
        isThis: false,
        isActive: holderEntry !== undefined,
        partition: holderEntry?.partition,
      }
    })
  })

  function formatDateTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  function truncate(id: string): string {
    if (id.length <= 16) return id
    return `${id.slice(0, 8)}…${id.slice(-6)}`
  }

  const BADGE_CLASS =
    'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap'
</script>

<div class="flex flex-col gap-4 pt-8">
  {#if !hasPostageBatch}
    <div class="flex flex-col gap-2">
      <p class="text-center font-bold">No synced account yet.</p>
      <p class="text-center text-sm">
        Multi-device sync requires a postage stamp. Assign one in the Stamps tab to enable uploading
        and see all registered devices here.
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <p class="font-medium">Devices</p>
        <Button variant="ghost" size="xs" onclick={() => doRefresh()} disabled={refreshing}>
          <RefreshCw />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <p class="text-muted-foreground text-sm">
        Devices registered to this account. At most {account.partitionCount ?? 1} can upload simultaneously.
      </p>
      {#if refreshError}
        <p class="text-destructive text-sm">Refresh failed: {refreshError}</p>
      {:else if noBackup}
        <div class="flex flex-col items-start gap-2">
          <p class="text-sm">
            No backup found on this node yet. If you recently replaced your postage stamp, your
            account republishes automatically — this can take a minute. Publish it now or refresh
            again shortly.
          </p>
          <Button size="sm" onclick={() => doPublish()} disabled={publishing || refreshing}>
            {publishing ? 'Publishing…' : 'Publish backup now'}
          </Button>
        </div>
      {:else if refreshedAt}
        <p class="text-muted-foreground text-sm">Last refreshed {formatRelative(refreshedAt)}</p>
      {/if}
    </div>

    {#if deviceRows.length === 0}
      <div class="flex flex-col gap-2">
        <p class="text-center font-bold">No devices registered yet.</p>
        <p class="text-center text-sm">Sign in on another device to register it here.</p>
      </div>
    {:else}
      <div class="flex flex-col gap-4">
        {#each deviceRows as row (row.deviceId)}
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <Laptop class="size-4 shrink-0" />
              {#if row.name}
                <div class="flex flex-col items-start">
                  <p class="text-sm">{row.name}</p>
                  <p class="text-muted-foreground font-mono text-xs">{truncate(row.deviceId)}</p>
                </div>
              {:else}
                <p class="font-mono text-sm">{truncate(row.deviceId)}</p>
              {/if}
              <CopyButton text={row.deviceId} />
            </div>

            <div class="flex gap-2 pl-6">
              {#if row.isThis}
                <span class={`${BADGE_CLASS} bg-primary text-primary-foreground`}>This device</span>
              {/if}
              {#if row.isActive}
                <span class={`${BADGE_CLASS} bg-success text-success-foreground`}>
                  <CircleCheckBig class="size-3" />
                  Active · partition {row.partition}
                </span>
              {:else}
                <span class={`${BADGE_CLASS} bg-muted text-muted-foreground`}>Inactive</span>
              {/if}
            </div>

            <div class="text-muted-foreground flex gap-4 pl-6 text-sm">
              {#if row.createdAt}
                <span>Added {formatDateTime(row.createdAt)}</span>
              {/if}
              {#if row.lastSignedInAt}
                <span>Last seen {formatDateTime(row.lastSignedInAt)}</span>
              {/if}
            </div>
          </div>
          <div class="bg-border h-px"></div>
        {/each}
      </div>
    {/if}

    <!-- Debug: the self lease (shared localStorage cache) and the peer
         holders (lock SOCs on Swarm), vs this device's id. -->
    <div class="flex flex-col items-start gap-0.5">
      <div class="bg-border h-px w-full"></div>
      <p class="text-sm font-bold">Debug · lease state</p>
      <p class="font-mono text-sm">this device: {thisDeviceId ?? '—'}</p>
      {#if leaseCache?.self}
        <p class="font-mono text-sm">
          self (localStorage): partition {leaseCache.self.partition} — {leaseLiveness(
            leaseCache.self.leasedUntil,
          )}
        </p>
        <p class="font-mono text-sm">
          self deviceId: {leaseCache.deviceId} (matches this device: {leaseCache.deviceId ===
          thisDeviceId
            ? 'yes'
            : 'no'})
        </p>
      {:else}
        <p class="font-mono text-sm">self (localStorage): none</p>
      {/if}
      {#if holders.length === 0}
        <p class="text-sm">peers (lock SOCs): none observed</p>
      {:else}
        {#each holders as h (h.partition)}
          <p class="font-mono text-sm">
            peer partition {h.partition} → {h.deviceId} (until {formatDateTime(h.leasedUntil)})
          </p>
        {/each}
      {/if}
    </div>
  {/if}
</div>
