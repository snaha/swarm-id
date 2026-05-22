<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { browser } from '$app/environment'
  import { page } from '$app/state'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Divider from '$lib/components/ui/divider.svelte'
  import CopyButton from '$lib/components/copy-button.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { getOrCreateDeviceId, leaseStateStorageKey, type LeaseState } from '@snaha/swarm-id'
  import Laptop from 'carbon-icons-svelte/lib/Laptop.svelte'
  import CheckmarkFilled from 'carbon-icons-svelte/lib/CheckmarkFilled.svelte'

  const identityId = $derived(page.params.id)
  const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
  const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)
  const thisDeviceId = browser ? getOrCreateDeviceId() : undefined

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

<Vertical --vertical-gap="var(--double-padding)" style="padding-top: var(--double-padding);">
  <Vertical --vertical-gap="var(--half-padding)">
    <Typography>Devices</Typography>
    <Typography variant="small">
      Devices that have accessed this account. At most {account?.partitionCount ?? 1} can upload simultaneously.
    </Typography>
  </Vertical>

  {#if (account?.partitionCount ?? 1) <= 1}
    <Typography variant="small">Multi-device mode is not enabled for this account.</Typography>
  {:else if deviceRows.length === 0}
    <Typography variant="small">No devices registered yet.</Typography>
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
