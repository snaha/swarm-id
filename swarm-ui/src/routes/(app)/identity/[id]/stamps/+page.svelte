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
  import { getBlockTimestamp } from '@swarm-id/lib'
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

  onMount(async () => {
    // Fetch Swarmscan price
    try {
      const res = await fetch(SWARMSCAN_STATS_URL)
      const data: { pricePerGBPerMonth: number } = await res.json()
      pricePerGBPerMonth = data.pricePerGBPerMonth
    } catch {
      // Silently fail — expiry date just won't render
    }

    // Fetch block timestamps for stamps
    const stamps = [accountStamp, identityStamp].filter(Boolean) as PostageStamp[]
    for (const stamp of stamps) {
      if (stamp.blockNumber > 0) {
        fetchBlockTimestamp(stamp.blockNumber)
      }
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

  function formatExpiryDate(
    stamp: PostageStamp,
    price: number,
    blockTimestamp: number | undefined,
  ): string {
    const durationSeconds = calculateBatchDurationSeconds(stamp.amount, price)

    // Use block timestamp if available, otherwise fall back to createdAt
    const startTimeMs =
      blockTimestamp !== undefined ? blockTimestamp * MS_PER_SECOND : stamp.createdAt

    return new Date(startTimeMs + durationSeconds * MS_PER_SECOND).toLocaleDateString()
  }

  function isExpiringSoon(
    stamp: PostageStamp,
    price: number,
    blockTimestamp: number | undefined,
  ): boolean {
    const totalLifetimeMs = calculateBatchDurationSeconds(stamp.amount, price) * MS_PER_SECOND

    // Use block timestamp if available, otherwise fall back to createdAt
    const startTimeMs =
      blockTimestamp !== undefined ? blockTimestamp * MS_PER_SECOND : stamp.createdAt

    const expiryTimestamp = startTimeMs + totalLifetimeMs
    const remainingMs = expiryTimestamp - Date.now()
    const oneMonthMs = Number(SECONDS_PER_MONTH) * MS_PER_SECOND

    return (
      remainingMs > 0 &&
      (remainingMs < oneMonthMs || remainingMs < totalLifetimeMs * EXPIRY_SOON_LIFETIME_FRACTION)
    )
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

      {#if pricePerGBPerMonth}
        {@const stampBlockTimestamp = blockTimestamps.get(stamp.blockNumber)}
        {@const expiringSoon = isExpiringSoon(stamp, pricePerGBPerMonth, stampBlockTimestamp)}
        <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
          <Typography>Expiry date</Typography>
          <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
            <Typography --typography-color={expiringSoon ? 'var(--colors-red)' : undefined}>
              {formatExpiryDate(stamp, pricePerGBPerMonth, stampBlockTimestamp)}
            </Typography>
            {#if expiringSoon}
              <Badge variant="error" dimension="small"
                ><WarningAltFilled size={16} />Expires soon</Badge
              >
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
