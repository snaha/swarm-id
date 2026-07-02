<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Utils } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import {
    DEFAULT_BEE_NODE_URL,
    calculateStampAmountForDays,
    fetchChainState,
  } from '@snaha/swarm-id'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { unlockAccount } from '$lib/crypto/unlock'
  import {
    LIFESPAN_UNIT_OPTIONS,
    type LifespanUnit,
    SECONDS_PER_DAY,
    formatBytes,
    lifespanToSeconds,
  } from '$lib/drives'
  import { fetchExistingStamp } from '$lib/payment/bee'
  import { type StampPurchaseHandle, openStampPurchaseWidget } from '$lib/payment/multichain-widget'
  import { derivePostageSigner, stampFromBatch } from '$lib/payment/purchase'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
  import type { Account } from '$lib/types'

  const COST_SIGNIFICANT_DIGITS = 4
  const BATCH_ID_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/

  const STORAGE_OPTIONS = [
    { value: 'new', label: 'Purchase new batch' },
    { value: 'existing', label: 'Use existing batch' },
  ]

  interface Props {
    account: Account
    onClose: () => void
    onAdded?: (message: string) => void
  }

  let { account, onClose, onAdded }: Props = $props()

  type Storage = 'new' | 'existing'
  type Phase = 'form' | 'unlock' | 'pending' | 'error' | 'unconfirmed'

  /** Positional default shown as the name placeholder and used when left blank. */
  function suggestedName() {
    return `Drive ${account.stamps.length + 1}`
  }

  let storage = $state<Storage>('new')
  let name = $state('')
  let depthValue = $state('')
  let lifespanValue = $state('1')
  let lifespanUnit = $state<LifespanUnit>('years')
  let batchIdInput = $state('')

  let phase = $state<Phase>('form')
  let pendingLabel = $state('')
  let errorMessage = $state('')
  let password = $state('')

  let currentPrice = $state<bigint | undefined>(undefined)
  let entropy: Uint8Array | undefined
  // Bumped on cancel/close so a late ceremony or widget callback can't complete.
  let attempt = 0
  // In-flight widget purchase; cancelled on close so the popup can't settle a
  // payment we would silently drop.
  let purchase: StampPurchaseHandle | undefined

  const sizeOptions = [
    { value: '', label: 'Please select' },
    ...[...Utils.getStampEffectiveBytesBreakpoints(false).entries()]
      .sort(([a], [b]) => a - b)
      .map(([depth, bytes]) => ({ value: String(depth), label: formatBytes(bytes) })),
  ]

  const lifespanSeconds = $derived(lifespanToSeconds(Number(lifespanValue), lifespanUnit))

  const estimateBzz = $derived.by(() => {
    if (
      storage !== 'new' ||
      depthValue === '' ||
      currentPrice === undefined ||
      lifespanSeconds <= 0
    ) {
      return undefined
    }
    // Round up: Bee enforces a 24h floor, and rounding a fractional day down
    // would under-estimate the cost (matches drive-extend-dialog).
    const days = Math.max(1, Math.ceil(lifespanSeconds / SECONDS_PER_DAY))
    const amount = calculateStampAmountForDays(currentPrice, days)
    if (amount <= 0n) {
      return undefined
    }
    try {
      return Utils.getStampCost(Number(depthValue), amount).toSignificantDigits(
        COST_SIGNIFICANT_DIGITS,
      )
    } catch {
      return undefined
    }
  })

  const batchIdValid = $derived(BATCH_ID_PATTERN.test(batchIdInput.trim()))
  const canProceed = $derived(
    storage === 'new' ? depthValue !== '' && lifespanSeconds > 0 : batchIdValid,
  )

  const infoText = $derived.by(() => {
    if (storage === 'existing') {
      return batchIdValid ? "Don't reuse batches across accounts." : 'Enter a batch ID to proceed.'
    }
    if (!canProceed) {
      return 'Set storage options to proceed.'
    }
    return estimateBzz ? `Estimated cost ≈ ${estimateBzz} BZZ` : 'Final cost is shown at payment.'
  })

  function unlockLabel() {
    if (account.access.type === 'eth-wallet') {
      return 'Confirm with wallet'
    }
    if (account.access.type === 'password') {
      return 'Verifying password…'
    }
    return 'Confirm with passkey'
  }

  $effect(() => {
    fetchChainState(DEFAULT_BEE_NODE_URL)
      .then((state) => (currentPrice = state.currentPrice))
      .catch(() => undefined)
  })

  function close() {
    attempt++
    purchase?.cancel()
    purchase = undefined
    onClose()
  }

  function proceed() {
    errorMessage = ''
    if (entropy) {
      void runWithEntropy(entropy)
      return
    }
    if (account.access.type === 'password') {
      phase = 'unlock'
      return
    }
    void unlock()
  }

  async function unlock() {
    const myAttempt = ++attempt
    phase = 'pending'
    pendingLabel = unlockLabel()
    try {
      const unlocked = await unlockAccount(
        account,
        account.access.type === 'password' ? password : undefined,
      )
      if (myAttempt !== attempt) {
        return
      }
      entropy = unlocked
      password = ''
      await runWithEntropy(unlocked)
    } catch (caught) {
      if (myAttempt !== attempt) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Unlock failed.'
      phase = 'error'
    }
  }

  async function runWithEntropy(seed: Uint8Array) {
    if (storage === 'existing') {
      await attachExisting(seed)
    } else {
      await purchaseNew(seed)
    }
  }

  async function purchaseNew(seed: Uint8Array) {
    const myAttempt = ++attempt
    phase = 'pending'
    // The popup-less /dev mock settles locally — telling the user to look for a
    // popup window there is wrong.
    pendingLabel =
      devSettingsStore.data.mockStampEnabled && !devSettingsStore.data.mockStampPopup
        ? 'Simulating the purchase…'
        : 'Complete the purchase in the popup window.'
    // Capture the fallback now: computed at settlement it could differ from the
    // placeholder the user saw (a sync pull / another tab adding a stamp meanwhile).
    const driveName = name.trim() || suggestedName()
    try {
      const { signerKey, destination } = await derivePostageSigner(seed)
      purchase = openStampPurchaseWidget({
        destination,
        // /dev mock (see dev-settings): simulate the purchase without a real
        // cross-chain payment. No-op in production, where the toggle is off.
        mocked: devSettingsStore.data.mockStampEnabled,
        mockPopup: devSettingsStore.data.mockStampPopup,
        mockError: devSettingsStore.data.mockStampResult === 'error',
        onSuccess: (batch) => {
          if (myAttempt !== attempt) {
            return
          }
          const ttl = lifespanSeconds > 0 ? lifespanSeconds : undefined
          account.addStamp(stampFromBatch(batch, signerKey, driveName, ttl))
          succeed()
        },
        onError: (error) => {
          if (myAttempt !== attempt) {
            return
          }
          errorMessage = error.message
          phase = 'error'
        },
        onCancel: () => {
          if (myAttempt === attempt) {
            phase = 'form'
          }
        },
        onUnconfirmedClose: () => {
          if (myAttempt === attempt) {
            phase = 'unconfirmed'
          }
        },
      })
    } catch (caught) {
      if (myAttempt !== attempt) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not start the purchase.'
      phase = 'error'
    }
  }

  async function attachExisting(seed: Uint8Array) {
    const myAttempt = ++attempt
    phase = 'pending'
    pendingLabel = 'Looking up the batch…'
    const driveName = name.trim() || suggestedName()
    try {
      const { signerKey } = await derivePostageSigner(seed)
      const stamp = await fetchExistingStamp(batchIdInput.trim(), signerKey, driveName)
      if (myAttempt !== attempt) {
        return
      }
      if (!stamp) {
        errorMessage = 'Couldn’t load that batch from the node. Check the Batch ID and try again.'
        phase = 'error'
        return
      }
      account.addStamp(stamp)
      succeed()
    } catch (caught) {
      if (myAttempt !== attempt) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not add the drive.'
      phase = 'error'
    }
  }

  function succeed() {
    onAdded?.('Drive added')
    close()
  }
</script>

{#if phase === 'pending'}
  <Dialog onclose={close} dismissable={false} title="Add drive">
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm">{pendingLabel}</p>
    </div>
    <Button variant="outline" class="w-full" onclick={close}>Cancel</Button>
  </Dialog>
{:else if phase === 'error'}
  <Dialog onclose={close} title="Add drive">
    <div class="flex items-start gap-2">
      <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      <p class="text-sm">{errorMessage}</p>
    </div>
    <div class="flex w-full flex-col gap-2">
      <Button class="w-full" onclick={() => ((phase = 'form'), (errorMessage = ''))}
        >Try again</Button
      >
      <Button variant="outline" class="w-full" onclick={close}>Close</Button>
    </div>
  </Dialog>
{:else if phase === 'unconfirmed'}
  <Dialog onclose={close} title="Purchase not confirmed">
    <div class="flex items-start gap-2">
      <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      <p class="text-sm">
        The payment window closed before we could confirm the purchase. If you completed payment,
        your drive may still appear shortly — don't pay again without checking.
      </p>
    </div>
    <Button variant="outline" class="w-full" onclick={close}>Close</Button>
  </Dialog>
{:else if phase === 'unlock'}
  <Dialog onclose={close} title="Unlock to continue">
    <p class="text-sm">Enter your account password to authorize this purchase.</p>
    <Input
      type="password"
      bind:value={password}
      placeholder="Account password"
      autocomplete="current-password"
      onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && password.length > 0 && unlock()}
    />
    <Button class="w-full" disabled={password.length === 0} onclick={unlock}>
      Unlock & continue
    </Button>
  </Dialog>
{:else}
  <Dialog onclose={close} title="Add drive">
    <div class="flex w-full flex-col gap-2">
      <label for="drive-name" class="text-sm font-medium">Name</label>
      <Input id="drive-name" bind:value={name} placeholder={suggestedName()} />
    </div>

    <div class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Storage</span>
      <Select options={STORAGE_OPTIONS} bind:value={storage} />
    </div>

    {#if storage === 'new'}
      <div class="flex w-full flex-col gap-2">
        <span class="text-sm font-medium">Size up to</span>
        <Select options={sizeOptions} bind:value={depthValue} />
      </div>

      <div class="flex w-full flex-col gap-2">
        <span class="text-sm font-medium">Lifespan up to</span>
        <div class="flex w-full items-center gap-2">
          <Input type="number" min="1" bind:value={lifespanValue} class="flex-1" />
          <Select options={LIFESPAN_UNIT_OPTIONS} bind:value={lifespanUnit} class="w-32" />
        </div>
      </div>
    {:else}
      <div class="flex w-full flex-col gap-2">
        <label for="drive-batch" class="text-sm font-medium">Batch ID</label>
        <Input id="drive-batch" bind:value={batchIdInput} placeholder="0x…" class="font-mono" />
        <p class="text-muted-foreground text-xs">Don't reuse batches across accounts.</p>
      </div>
    {/if}

    <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">{infoText}</p>

    <Button class="w-full" disabled={!canProceed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
