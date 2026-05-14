<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Badge from '$lib/components/ui/badge.svelte'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { page } from '$app/state'
  import Divider from '$lib/components/ui/divider.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'
  import type { BatchId } from '@ethersphere/bee-js'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import CopyButton from '$lib/components/copy-button.svelte'
  import type { PostageStamp } from '$lib/types'
  import { onMount } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import WarningAltFilled from 'carbon-icons-svelte/lib/WarningAltFilled.svelte'
  import { getBlockTimestamp, fetchBatchTTL } from '@snaha/swarm-id'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

  const BATCH_ID_PREVIEW_LENGTH = 8
  const CHUNK_SIZE_BYTES = 4096
  const BYTES_PER_KB = 1024
  const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB
  const BYTES_PER_GB = BYTES_PER_MB * BYTES_PER_KB
  const MS_PER_SECOND = 1000
  const MAX_UTILIZATION_PERCENT = 100
  const SWARMSCAN_STATS_URL = 'https://api.swarmscan.io/v1/postage-stamps/stats'
  const CHUNKS_PER_GB = 262144n
  const SECONDS_PER_MONTH = 2592000n
  const EXPIRY_SOON_LIFETIME_FRACTION = 0.1
  const PLUR_DECIMALS = 16
  const BEEPORT_TOPUP_URL = 'https://beeport.eth.limo/?topup='

  function bzzToPlur(bzz: number): bigint {
    const str = bzz.toFixed(PLUR_DECIMALS)
    const [intPart, decPart = ''] = str.split('.')
    const paddedDec = decPart.padEnd(PLUR_DECIMALS, '0').slice(0, PLUR_DECIMALS)
    return BigInt(intPart + paddedDec)
  }

  function calculateBatchDurationSeconds(amount: bigint, pricePerGBPerMonth: number): number {
    const perChunkPerMonthCost = bzzToPlur(pricePerGBPerMonth) / CHUNKS_PER_GB
    if (perChunkPerMonthCost === 0n) return 0
    return Number((amount * SECONDS_PER_MONTH) / perChunkPerMonthCost)
  }

  const identityId = $derived(page.params.id)
  const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
  const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)
  const accountStamp = $derived(
    account?.defaultPostageStampBatchID
      ? postageStampsStore.getStamp(account.defaultPostageStampBatchID)
      : undefined,
  )
  const identityStamp = $derived(
    identity?.defaultPostageStampBatchID
      ? postageStampsStore.getStamp(identity.defaultPostageStampBatchID)
      : undefined,
  )

  let pricePerGBPerMonth = $state<number | undefined>(undefined)
  const blockTimestamps = new SvelteMap<number, number>()
  // Map of batchID hex → { expiry timestamp in ms, sourced from Bee node /stamps/{id} }.
  // The Bee node computes batchTTL from current chain state, so it accounts for
  // price changes since stamp creation that the Swarmscan approximation cannot.
  const beeExpiryMs = new SvelteMap<string, number>()

  async function fetchBlockTimestamp(blockNumber: number): Promise<number | undefined> {
    if (blockTimestamps.has(blockNumber)) {
      return blockTimestamps.get(blockNumber)
    }

    try {
      const timestamp = await getBlockTimestamp(
        networkSettingsStore.settings.gnosisRpcUrl,
        blockNumber,
      )
      blockTimestamps.set(blockNumber, timestamp)
      return timestamp
    } catch {
      return undefined
    }
  }

  async function fetchStampExpiryFromBee(stamp: PostageStamp): Promise<void> {
    const ttlSeconds = await fetchBatchTTL(networkSettingsStore.beeNodeUrl, stamp.batchID.toHex())
    if (ttlSeconds !== undefined) {
      beeExpiryMs.set(stamp.batchID.toHex(), Date.now() + ttlSeconds * MS_PER_SECOND)
    }
  }

  onMount(async () => {
    // Fetch Swarmscan price
    try {
      const res = await fetch(SWARMSCAN_STATS_URL)
      const data: { pricePerGBPerMonth: number } = await res.json()
      pricePerGBPerMonth = data.pricePerGBPerMonth
    } catch {
      // Silently fail — expiry date just won't render
    }

    // Fetch block timestamps and authoritative batchTTL for stamps
    const stamps = [accountStamp, identityStamp].filter(Boolean) as PostageStamp[]
    for (const stamp of stamps) {
      if (stamp.blockNumber > 0) {
        fetchBlockTimestamp(stamp.blockNumber)
      }
      fetchStampExpiryFromBee(stamp)
    }
  })

  function formatBytes(bytes: number): string {
    if (bytes < BYTES_PER_KB) return `${bytes} B`
    if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
    if (bytes < BYTES_PER_GB) return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
    return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`
  }

  function formatCapacity(utilization: number, depth: number): string {
    const totalChunks = Math.pow(2, depth)
    const totalBytes = totalChunks * CHUNK_SIZE_BYTES
    const usedBytes = totalBytes * utilization

    return `${formatBytes(usedBytes)} of ${formatBytes(totalBytes)} used`
  }

  function formatBatchId(batchId: BatchId): string {
    return batchId.toHex().slice(0, BATCH_ID_PREVIEW_LENGTH)
  }

  /**
   * Resolves a stamp's expiry timestamp in ms.
   * Prefers the Bee node's batchTTL (which uses live chain state) over the
   * Swarmscan-price approximation, which assumes price has been constant since
   * stamp creation and produces dates in the past once the chain price rises.
   */
  function getExpiryMs(
    stamp: PostageStamp,
    price: number | undefined,
    blockTimestamp: number | undefined,
    beeExpiry: number | undefined,
  ): number | undefined {
    if (beeExpiry !== undefined) {
      return beeExpiry
    }
    if (price === undefined) {
      return undefined
    }
    const durationSeconds = calculateBatchDurationSeconds(stamp.amount, price)
    const startTimeMs =
      blockTimestamp !== undefined ? blockTimestamp * MS_PER_SECOND : stamp.createdAt
    return startTimeMs + durationSeconds * MS_PER_SECOND
  }

  function formatExpiryDate(expiryMs: number): string {
    return new Date(expiryMs).toLocaleDateString()
  }

  function isExpired(expiryMs: number): boolean {
    return expiryMs <= Date.now()
  }

  function isExpiringSoon(
    stamp: PostageStamp,
    expiryMs: number,
    price: number | undefined,
  ): boolean {
    const remainingMs = expiryMs - Date.now()
    if (remainingMs <= 0) return false

    const oneMonthMs = Number(SECONDS_PER_MONTH) * MS_PER_SECOND
    if (remainingMs < oneMonthMs) return true

    // If we have a price, also flag stamps in the last 10% of their estimated lifetime.
    if (price === undefined) return false
    const totalLifetimeMs = calculateBatchDurationSeconds(stamp.amount, price) * MS_PER_SECOND
    return totalLifetimeMs > 0 && remainingMs < totalLifetimeMs * EXPIRY_SOON_LIFETIME_FRACTION
  }
</script>

{#snippet stampDetails(stamp: PostageStamp, isAccountStamp: boolean)}
  <Vertical --vertical-gap="var(--padding)">
    <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
      <Typography bold>{formatBatchId(stamp.batchID)}</Typography>
      {#if isAccountStamp}
        <Badge dimension="small">Account stamp</Badge>
      {:else}
        <Badge dimension="small">Identity stamp</Badge>
      {/if}
    </Horizontal>

    <Vertical --vertical-gap="var(--half-padding)">
      <Input
        label="Stamp ID"
        variant="outline"
        dimension="compact"
        value={stamp.batchID.toHex()}
        readonly
      >
        {#snippet buttons()}
          <CopyButton text={stamp.batchID.toHex()} />
          <Button
            variant="ghost"
            dimension="compact"
            href={`${BEEPORT_TOPUP_URL}${stamp.batchID.toHex()}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Top up
          </Button>
        {/snippet}
      </Input>

      <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
        <div class="capacity-label">
          <Typography>{formatCapacity(stamp.utilization, stamp.depth)}</Typography>
        </div>
        <div class="progress-bar">
          <div
            class="progress-bar-fill"
            style="width: {Math.min(
              stamp.utilization * MAX_UTILIZATION_PERCENT,
              MAX_UTILIZATION_PERCENT,
            )}%"
          ></div>
        </div>
      </Horizontal>

      {@const stampBlockTimestamp = blockTimestamps.get(stamp.blockNumber)}
      {@const stampBeeExpiry = beeExpiryMs.get(stamp.batchID.toHex())}
      {@const expiryMs = getExpiryMs(
        stamp,
        pricePerGBPerMonth,
        stampBlockTimestamp,
        stampBeeExpiry,
      )}
      {#if expiryMs !== undefined}
        {@const expired = isExpired(expiryMs)}
        {@const expiringSoon = !expired && isExpiringSoon(stamp, expiryMs, pricePerGBPerMonth)}
        <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
          <Typography>Expiry date</Typography>
          <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
            <Typography
              --typography-color={expired || expiringSoon ? 'var(--colors-red)' : undefined}
            >
              {formatExpiryDate(expiryMs)}
            </Typography>
            {#if expired}
              <Badge variant="error" dimension="small">
                <WarningAltFilled size={16} />Expired
              </Badge>
            {:else if expiringSoon}
              <Badge variant="error" dimension="small">
                <WarningAltFilled size={16} />Expires soon
              </Badge>
            {/if}
          </Horizontal>
        </Horizontal>
      {/if}
    </Vertical>
  </Vertical>
{/snippet}

<Vertical --vertical-gap="var(--double-padding)" style="padding-top: var(--double-padding);">
  {#if identityStamp}
    <Typography>This identity uses a separate postage stamp for extra privacy.</Typography>

    {@render stampDetails(identityStamp, false)}

    <Divider --margin="0" />

    {#if accountStamp}
      {@render stampDetails(accountStamp, true)}
    {/if}
  {:else if accountStamp}
    <Typography>This identity uses your account's postage stamp.</Typography>
    {@render stampDetails(accountStamp, true)}

    <Divider --margin="0" />
    <Vertical --vertical-gap="var(--half-padding)" --vertical-align-items="start">
      <Button
        variant="ghost"
        dimension="compact"
        onclick={() => identityId && goto(resolve(routes.IDENTITY_STAMPS_NEW, { id: identityId }))}
      >
        Use separate stamp
      </Button>
      <Typography variant="small">
        Use a separate stamp to keep this identity's activity private from your other identities.
      </Typography>
    </Vertical>
  {:else}
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography bold center>No stamps yet.</Typography>
      <Typography center>
        Your account is local and stored only on this device. To upload data and sync across
        devices, upgrade to a synced account by purchasing a Swarm postage stamp.
      </Typography>
    </Vertical>
    <Horizontal --horizontal-justify-content="center" --horizontal-gap="var(--half-padding)">
      <Button
        variant="strong"
        dimension="compact"
        onclick={() => identityId && goto(resolve(routes.IDENTITY_STAMPS_NEW, { id: identityId }))}
      >
        Add postage stamp
      </Button>
    </Horizontal>
  {/if}
</Vertical>

<style>
  .capacity-label {
    flex: 1;
    min-width: 0;
  }

  .progress-bar {
    flex: 1;
    min-width: 0;
    height: 4px;
    background: var(--colors-low);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--colors-high);
    border-radius: 2px;
  }
</style>
