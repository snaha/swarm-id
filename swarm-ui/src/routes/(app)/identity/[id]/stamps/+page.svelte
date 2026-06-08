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
  import {
    calculateTTLSeconds,
    fetchAuthoritativeBatchTTL,
    fetchSwarmPrice,
    getBlockTimestamp,
  } from '@snaha/swarm-id'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

  const BATCH_ID_PREVIEW_LENGTH = 8
  const CHUNK_SIZE_BYTES = 4096
  const BYTES_PER_KB = 1024
  const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB
  const BYTES_PER_GB = BYTES_PER_MB * BYTES_PER_KB
  const MS_PER_SECOND = 1000
  const SECONDS_PER_MONTH = 2592000
  const MAX_UTILIZATION_PERCENT = 100
  const EXPIRY_SOON_LIFETIME_FRACTION = 0.1
  const BEEPORT_TOPUP_URL = 'https://beeport.eth.limo/?topup='

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
  // Map of batchID hex → expiry timestamp in ms (Date.now() + remaining TTL),
  // sourced from live chain state. We read the PostageStamp contract directly by
  // batchId (ground truth, works for any batch — including manually added stamps
  // the Bee node does not track, see #344), and fall back to the Bee node's
  // `/stamps/{id}` batchTTL only when the RPC read is unavailable. Both account
  // for price changes since stamp creation that the Swarmscan-price
  // approximation cannot.
  const chainExpiryMs = new SvelteMap<string, number>()

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

  async function fetchStampExpiry(stamp: PostageStamp): Promise<void> {
    const batchId = stamp.batchID.toHex()
    // Resolve remaining TTL from the most authoritative source: the on-chain
    // PostageStamp contract first (works for any batchId, even one the
    // configured Bee node has never seen), then the Bee node's batchTTL.
    const ttlSeconds = await fetchAuthoritativeBatchTTL(
      networkSettingsStore.gnosisRpcUrl,
      networkSettingsStore.beeNodeUrl,
      batchId,
    )
    if (ttlSeconds !== undefined) {
      chainExpiryMs.set(batchId, Date.now() + ttlSeconds * MS_PER_SECOND)
    }
  }

  onMount(() => {
    // Start the authoritative chain/Bee batchTTL + block-timestamp fetches
    // first; they don't depend on the Swarmscan price and shouldn't wait on it.
    const stamps = [accountStamp, identityStamp].filter(Boolean) as PostageStamp[]
    for (const stamp of stamps) {
      if (stamp.blockNumber > 0) {
        fetchBlockTimestamp(stamp.blockNumber)
      }
      fetchStampExpiry(stamp)
    }

    // Swarmscan price feeds only the constant-price fallback and the
    // "expires soon" heuristic, so run it in parallel and let it fail
    // silently — the Bee batchTTL path can still render an accurate date.
    fetchSwarmPrice()
      .then((price) => {
        pricePerGBPerMonth = price
      })
      .catch(() => {})
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

  interface StampExpiry {
    expiryMs: number
    /** True when expiryMs comes from the constant-price fallback rather than
     * Bee's live chain state. The chain price may have moved since the stamp
     * was purchased, so an estimated date can disagree with reality (see #279).
     */
    estimated: boolean
  }

  /**
   * Resolves a stamp's expiry timestamp in ms, marking it as estimated when
   * we had to fall back to the Swarmscan-price approximation. The chain-sourced
   * expiry (PostageStamp contract, or Bee's batchTTL) reflects actual chain
   * state and is treated as truth.
   */
  function getExpiry(
    stamp: PostageStamp,
    price: number | undefined,
    blockTimestamp: number | undefined,
    chainExpiry: number | undefined,
  ): StampExpiry | undefined {
    if (chainExpiry !== undefined) {
      return { expiryMs: chainExpiry, estimated: false }
    }
    if (price === undefined) {
      return undefined
    }
    const durationSeconds = calculateTTLSeconds(stamp.amount, price)
    const startTimeMs =
      blockTimestamp !== undefined ? blockTimestamp * MS_PER_SECOND : stamp.createdAt
    return { expiryMs: startTimeMs + durationSeconds * MS_PER_SECOND, estimated: true }
  }

  function formatExpiryDate(expiryMs: number, estimated: boolean): string {
    const date = new Date(expiryMs).toLocaleDateString()
    return estimated ? `~${date}` : date
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

    const oneMonthMs = SECONDS_PER_MONTH * MS_PER_SECOND
    if (remainingMs < oneMonthMs) return true

    // If we have a price, also flag stamps in the last 10% of their estimated lifetime.
    if (price === undefined) return false
    const totalLifetimeMs = calculateTTLSeconds(stamp.amount, price) * MS_PER_SECOND
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
      {@const stampChainExpiry = chainExpiryMs.get(stamp.batchID.toHex())}
      {@const expiry = getExpiry(stamp, pricePerGBPerMonth, stampBlockTimestamp, stampChainExpiry)}
      {#if expiry !== undefined}
        {@const expired = isExpired(expiry.expiryMs)}
        {@const expiringSoon =
          !expired && isExpiringSoon(stamp, expiry.expiryMs, pricePerGBPerMonth)}
        <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
          <Typography>Expiry date</Typography>
          <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
            <Typography
              --typography-color={expired || expiringSoon ? 'var(--colors-red)' : undefined}
            >
              {formatExpiryDate(expiry.expiryMs, expiry.estimated)}
            </Typography>
            {#if expiry.estimated}
              <Typography variant="small">(estimated)</Typography>
            {/if}
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
