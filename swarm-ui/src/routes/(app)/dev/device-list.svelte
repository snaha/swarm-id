<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { browser } from '$app/environment'
  import { onMount } from 'svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Divider from '$lib/components/ui/divider.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import CopyButton from '$lib/components/copy-button.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { syncStore } from '$lib/stores/sync.svelte'
  import {
    getOrCreateDeviceId,
    deriveSwarmEncryptionKey,
    hexToUint8Array,
    leaseCacheStorageKey,
    PartitionLease,
    type Account,
    type PartitionLeaseStateSnapshot,
  } from '@snaha/swarm-id'
  import { Bee } from '@ethersphere/bee-js'
  import { refreshAccountFromSwarm } from '$lib/utils/refresh-account-from-swarm'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import Laptop from 'carbon-icons-svelte/lib/Laptop.svelte'
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte'
  import Renew from 'carbon-icons-svelte/lib/Renew.svelte'
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte'

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
  // time `applyRefreshedSnapshot` mutates the account), producing a loop.
  // onMount runs after initial render with no reactive subscriptions, so
  // it fires once per fresh mount and never again. Re-mounting the panel
  // (e.g. switching the selected account via {#key}) re-fires onMount —
  // that's how "re-visit to refresh" still works.
  onMount(() => {
    if (browser) void doRefresh()
  })

  let _tick = $state(0)
  $effect(() => {
    if (!browser) return
    // Re-render the relative timestamp every 30 s.
    const timer = setInterval(() => (_tick = _tick + 1), 30_000)
    return () => clearInterval(timer)
  })

  function formatRelative(ms: number): string {
    void _tick // depend on tick so the formatted string stays fresh
    const ago = Date.now() - ms
    if (ago < 5_000) return 'just now'
    if (ago < 60_000) return `${Math.floor(ago / 1_000)}s ago`
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
    return `${Math.floor(ago / 3_600_000)}h ago`
  }

  // Debug helper: is a lease still live, relative to now?
  function leaseLiveness(leasedUntil: number): string {
    void _tick // re-evaluate as time passes
    const now = Date.now()
    return leasedUntil > now
      ? `LIVE (now ${formatDateTime(now)})`
      : `EXPIRED ${Math.floor((now - leasedUntil) / 1000)}s ago (now ${formatDateTime(now)})`
  }

  const deviceRows = $derived.by(() => {
    // `_tick` so the self lease-expiry check re-evaluates over time.
    void _tick
    const now = Date.now()
    // Removed devices (tombstones) are hidden — a removal on any device makes
    // the row disappear here once the snapshot converges.
    return (account.devices ?? [])
      .filter((d) => !d.removedAt)
      .map((d) => {
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

  // Tombstone a peer device and publish, so the removal propagates (#337). The
  // current device is removed via sign-out, not here.
  function removeDevice(deviceId: string) {
    accountsStore.removeDevice(account.id, deviceId)
  }
</script>

<Vertical --vertical-gap="var(--padding)" style="padding-top: var(--double-padding);">
  {#if !hasPostageBatch}
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography bold center>No synced account yet.</Typography>
      <Typography center>
        Multi-device sync requires a postage stamp. Assign one in the Stamps tab to enable uploading
        and see all registered devices here.
      </Typography>
    </Vertical>
  {:else}
    <Vertical --vertical-gap="var(--half-padding)">
      <Horizontal
        --horizontal-gap="var(--half-padding)"
        --horizontal-align-items="center"
        --horizontal-justify-content="space-between"
      >
        <Typography>Devices</Typography>
        <Button
          variant="ghost"
          dimension="compact"
          onclick={() => doRefresh()}
          disabled={refreshing}
        >
          <Horizontal --horizontal-gap="4px" --horizontal-align-items="center">
            <Renew size={14} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Horizontal>
        </Button>
      </Horizontal>
      <Typography variant="small">
        Devices registered to this account. At most {account.partitionCount ?? 1} can upload simultaneously.
      </Typography>
      {#if refreshError}
        <Typography variant="small" --typography-color="var(--colors-danger, #da1e28)">
          Refresh failed: {refreshError}
        </Typography>
      {:else if noBackup}
        <Vertical --vertical-gap="var(--half-padding)" --vertical-align-items="start">
          <Typography variant="small">
            No backup found on this node yet. If you recently replaced your postage stamp, your
            account republishes automatically — this can take a minute. Publish it now or refresh
            again shortly.
          </Typography>
          <Button
            variant="strong"
            dimension="compact"
            onclick={() => doPublish()}
            disabled={publishing || refreshing}
          >
            {publishing ? 'Publishing…' : 'Publish backup now'}
          </Button>
        </Vertical>
      {:else if refreshedAt}
        <Typography variant="small">
          Last refreshed {formatRelative(refreshedAt)}
        </Typography>
      {/if}
    </Vertical>

    {#if deviceRows.length === 0}
      <Vertical --vertical-gap="var(--half-padding)">
        <Typography bold center>No devices registered yet.</Typography>
        <Typography center>Sign in on another device to register it here.</Typography>
      </Vertical>
    {:else}
      <Vertical --vertical-gap="var(--padding)">
        {#each deviceRows as row (row.deviceId)}
          <Vertical --vertical-gap="var(--half-padding)">
            <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
              <Laptop size={16} />
              {#if row.name}
                <Vertical --vertical-gap="0" --vertical-align-items="start">
                  <Typography>{row.name}</Typography>
                  <Typography variant="small" font="mono">{truncate(row.deviceId)}</Typography>
                </Vertical>
              {:else}
                <Typography font="mono">{truncate(row.deviceId)}</Typography>
              {/if}
              <CopyButton text={row.deviceId} />
            </Horizontal>

            <Horizontal --horizontal-gap="var(--half-padding)" style="padding-left: 24px;">
              {#if row.isThis}
                <span class="badge badge-this">This device</span>
              {/if}
              {#if row.isActive}
                <span class="badge badge-active">
                  <CheckmarkFilled size={12} />
                  Active · partition {row.partition}
                </span>
              {:else}
                <span class="badge badge-inactive">Inactive</span>
              {/if}
              {#if !row.isThis}
                <Button
                  variant="ghost"
                  dimension="compact"
                  onclick={() => removeDevice(row.deviceId)}
                >
                  <Horizontal --horizontal-gap="4px" --horizontal-align-items="center">
                    <TrashCan size={12} />
                    Remove
                  </Horizontal>
                </Button>
              {/if}
            </Horizontal>

            <Horizontal --horizontal-gap="var(--padding)" style="padding-left: 24px;">
              {#if row.createdAt}
                <Typography variant="small">Added {formatDateTime(row.createdAt)}</Typography>
              {/if}
              {#if row.lastSignedInAt}
                <Typography variant="small"
                  >Last seen {formatDateTime(row.lastSignedInAt)}</Typography
                >
              {/if}
            </Horizontal>
          </Vertical>
          <Divider --margin="0" />
        {/each}
      </Vertical>
    {/if}

    <!-- Debug: the self lease (shared localStorage cache) and the peer
         holders (lock SOCs on Swarm), vs this device's id. -->
    <Vertical --vertical-gap="2px" --vertical-align-items="start">
      <Divider --margin="0" />
      <Typography variant="small" bold>Debug · lease state</Typography>
      <Typography variant="small" font="mono">this device: {thisDeviceId ?? '—'}</Typography>
      {#if leaseCache?.self}
        <Typography variant="small" font="mono">
          self (localStorage): partition {leaseCache.self.partition} — {leaseLiveness(
            leaseCache.self.leasedUntil,
          )}
        </Typography>
        <Typography variant="small" font="mono">
          self deviceId: {leaseCache.deviceId} (matches this device: {leaseCache.deviceId ===
          thisDeviceId
            ? 'yes'
            : 'no'})
        </Typography>
      {:else}
        <Typography variant="small" font="mono">self (localStorage): none</Typography>
      {/if}
      {#if holders.length === 0}
        <Typography variant="small">peers (lock SOCs): none observed</Typography>
      {:else}
        {#each holders as h (h.partition)}
          <Typography variant="small" font="mono">
            peer partition {h.partition} → {h.deviceId} (until {formatDateTime(h.leasedUntil)})
          </Typography>
        {/each}
      {/if}
    </Vertical>
  {/if}
</Vertical>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .badge-this {
    background: var(--colors-primary, #dd7200);
    color: white;
  }

  .badge-active {
    background: var(--colors-success, #24a148);
    color: white;
  }

  .badge-inactive {
    background: var(--colors-low);
    color: var(--colors-high);
  }
</style>
