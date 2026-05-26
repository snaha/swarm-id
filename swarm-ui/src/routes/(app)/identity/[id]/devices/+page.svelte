<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { browser } from '$app/environment'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { onMount } from 'svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Divider from '$lib/components/ui/divider.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import CopyButton from '$lib/components/copy-button.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { getOrCreateDeviceId, leaseStateStorageKey, type LeaseState } from '@snaha/swarm-id'
  import { refreshAccountFromSwarm } from '$lib/utils/refresh-account-from-swarm'
  import routes from '$lib/routes'
  import Laptop from 'carbon-icons-svelte/lib/Laptop.svelte'
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte'
  import Renew from 'carbon-icons-svelte/lib/Renew.svelte'

  const identityId = $derived(page.params.id)
  const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
  const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)
  const thisDeviceId = browser ? getOrCreateDeviceId() : undefined

  const hasPostageBatch = $derived(
    !!account?.defaultPostageStampBatchID || !!identity?.defaultPostageStampBatchID,
  )

  let leaseState = $state<LeaseState | undefined>(undefined)

  $effect(() => {
    if (!browser || !account) return
    const key = leaseStateStorageKey(account.id.toHex())
    const raw = localStorage.getItem(key)
    leaseState = raw ? (JSON.parse(raw) as LeaseState) : undefined
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        leaseState = e.newValue ? (JSON.parse(e.newValue) as LeaseState) : undefined
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  })

  // Refresh state — pull the snapshot from Swarm so peers added on other
  // browsers show up here.
  let refreshing = $state(false)
  let refreshedAt = $state<number | undefined>(undefined)
  let refreshError = $state<string | undefined>(undefined)

  async function doRefresh() {
    if (!account || refreshing) return
    refreshing = true
    refreshError = undefined
    try {
      const result = await refreshAccountFromSwarm(account.id.toHex())
      if (result.ok) {
        refreshedAt = result.refreshedAt
      } else {
        refreshError = result.error
      }
    } finally {
      refreshing = false
    }
  }

  // Refresh exactly once when the component mounts. No $effect — that
  // re-fires whenever any tracked dependency changes (which happens every
  // time `applyRefreshedSnapshot` mutates the account), producing a loop.
  // onMount runs after initial render with no reactive subscriptions, so
  // it fires once per fresh mount and never again. Switching to another
  // tab and back creates a new component instance, which re-fires onMount
  // — that's how "re-visit the tab to refresh" still works.
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

  const deviceRows = $derived(
    (account?.devices ?? []).map((d) => {
      const isThis = d.deviceId === thisDeviceId
      const activeEntry = (account?.activeDevices ?? []).find((a) => a.deviceId === d.deviceId)
      const isActive = activeEntry !== undefined
      const partition = activeEntry?.partition
      const thisLease = isThis ? leaseState : undefined
      return { ...d, isThis, isActive, partition, thisLease }
    }),
  )

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function formatLeaseExpiry(leasedUntil: number): string {
    const remainingMs = leasedUntil - Date.now()
    if (remainingMs <= 0) return 'expired'
    const minutes = Math.floor(remainingMs / 60_000)
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(remainingMs / 3_600_000)
    return `${hours} h`
  }

  function truncate(id: string): string {
    if (id.length <= 16) return id
    return `${id.slice(0, 8)}…${id.slice(-6)}`
  }
</script>

<Vertical --vertical-gap="var(--padding)" style="padding-top: var(--double-padding);">
  {#if !hasPostageBatch}
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography bold center>No synced account yet.</Typography>
      <Typography center>
        Multi-device sync requires a postage stamp. Purchase one to enable uploading and see all
        your registered devices here.
      </Typography>
    </Vertical>
    <Horizontal --horizontal-justify-content="center">
      <Button
        variant="strong"
        dimension="compact"
        onclick={() => identityId && goto(resolve(routes.IDENTITY_STAMPS_NEW, { id: identityId }))}
      >
        Add postage stamp
      </Button>
    </Horizontal>
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
        Devices registered to this account. At most {account?.partitionCount ?? 1} can upload simultaneously.
      </Typography>
      {#if refreshError}
        <Typography variant="small" --typography-color="var(--colors-danger, #da1e28)">
          Refresh failed: {refreshError}
        </Typography>
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
            </Horizontal>

            <Horizontal --horizontal-gap="var(--padding)" style="padding-left: 24px;">
              {#if row.thisLease}
                {#if row.thisLease.isReadOnly}
                  <Typography variant="small">Read-only — all slots occupied</Typography>
                {:else if row.thisLease.leasedUntil !== undefined}
                  <Typography variant="small">
                    Lease expires in {formatLeaseExpiry(row.thisLease.leasedUntil)}
                  </Typography>
                {/if}
              {/if}
              {#if row.createdAt}
                <Typography variant="small">Added {formatDate(row.createdAt)}</Typography>
              {/if}
              {#if row.lastSignedInAt}
                <Typography variant="small">Last seen {formatDate(row.lastSignedInAt)}</Typography>
              {/if}
            </Horizontal>
          </Vertical>
          <Divider --margin="0" />
        {/each}
      </Vertical>
    {/if}
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
