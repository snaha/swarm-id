<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onDestroy } from 'svelte'

  import { PrivateKey, Utils } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { BatchIdSchema, PrivateKeySchema } from '@snaha/swarm-id'

  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { strip0x } from '$lib/crypto/hex'
  import {
    LIFESPAN_UNIT_OPTIONS,
    type LifespanUnit,
    formatBytes,
    lifespanToSeconds,
  } from '$lib/drives'
  import { verifyBatchStampable } from '$lib/payment/bee'
  import { currentChainPrice } from '$lib/payment/chain-price'
  import { fetchExistingBatchFromChain } from '$lib/payment/contract'
  import { type StampPurchaseHandle, openStampPurchaseWidget } from '$lib/payment/multichain-widget'
  import {
    derivePostageSigner,
    stampAmountForSeconds,
    stampCostBzz,
    stampFromBatch,
    stampTtlSeconds,
  } from '$lib/payment/purchase'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
  import type { Account } from '$lib/types'

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
  type Phase = 'form' | 'pending' | 'error' | 'unconfirmed'

  let storage = $state<Storage>('new')
  let name = $state('')
  let depthValue = $state('')
  let lifespanValue = $state('1')
  let lifespanUnit = $state<LifespanUnit>('years')
  let batchIdInput = $state('')
  let signerKeyInput = $state('')

  let phase = $state<Phase>('form')
  let pendingLabel = $state('')
  let errorMessage = $state('')

  let currentPrice = $state<bigint | undefined>(undefined)
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
    return stampCostBzz(Number(depthValue), stampAmountForSeconds(currentPrice, lifespanSeconds))
  })

  // Validate through the lib's canonical schemas (bare 64-hex), tolerating a
  // `0x` prefix by stripping first.
  const batchIdValid = $derived(BatchIdSchema.safeParse(strip0x(batchIdInput.trim())).success)
  // Optional: blank keeps the derive-from-account behaviour; a pasted key lets
  // the user attach a batch owned by an external signer. `pastedSignerKey` is the
  // trimmed non-empty key (undefined when blank) — the single source both the
  // attach guard and the derive/paste branch read, so no `seed as` cast is needed.
  const pastedSignerKey = $derived(signerKeyInput.trim() === '' ? undefined : signerKeyInput.trim())
  const signerKeyValid = $derived(
    pastedSignerKey === undefined || PrivateKeySchema.safeParse(strip0x(pastedSignerKey)).success,
  )
  const canProceed = $derived(
    storage === 'new' ? depthValue !== '' && lifespanSeconds > 0 : batchIdValid && signerKeyValid,
  )

  const infoText = $derived.by(() => {
    if (storage === 'existing') {
      if (!batchIdValid) {
        return 'Enter a batch ID to proceed.'
      }
      if (!signerKeyValid) {
        return "Enter a valid signer key, or leave it blank to use this account's key."
      }
      return "Don't reuse batches across accounts."
    }
    if (!canProceed) {
      return 'Set storage options to proceed.'
    }
    return estimateBzz ? `Estimated cost ≈ ${estimateBzz} BZZ` : 'Final cost is shown at payment.'
  })

  // Best-effort: the price only feeds the cost estimate here (and the TTL guess
  // for a settled purchase); the purchase itself never gates on it.
  $effect(() => {
    currentChainPrice()
      .then((price) => (currentPrice = price))
      .catch(() => undefined)
  })

  function close() {
    attempt++
    purchase?.cancel()
    purchase = undefined
    onClose()
  }

  // The dialog can unmount without close() (tab switch, navigation) — treat
  // that as a cancel so the popup poll and message listener don't outlive us.
  onDestroy(() => purchase?.cancel())

  function proceed() {
    errorMessage = ''
    // The batch owner is a deterministic function of the account's (plaintext)
    // derivation key, so no unlock is needed — buying spends real money in the
    // widget, which is confirmation enough.
    if (storage === 'existing') {
      void attachExisting()
    } else {
      void purchaseNew()
    }
  }

  async function purchaseNew() {
    const myAttempt = ++attempt
    phase = 'pending'
    // The popup-less /dev mock settles locally — telling the user to look for a
    // popup window there is wrong.
    pendingLabel =
      devSettingsStore.data.mockStampEnabled && !devSettingsStore.data.mockStampPopup
        ? 'Simulating the purchase…'
        : 'Complete the purchase in the popup window.'
    // Left blank, the drive stays unnamed and the UI falls back to its stable
    // batch-ID-derived label.
    const driveName = name.trim() || undefined
    try {
      const { signerKey, destination } = await derivePostageSigner(account.derivationKey)
      // The user may have cancelled during the derivation — bail before the
      // popup opens, or a payment window would appear after they backed out.
      if (myAttempt !== attempt) {
        return
      }
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
          // The size/lifespan actually bought are chosen INSIDE the widget —
          // the form's selection is only a pre-payment estimate. Derive the
          // lifespan from what settled (funded blocks × block time); when the
          // chain price never loaded it stays unknown rather than wrong.
          const ttl =
            currentPrice === undefined
              ? undefined
              : stampTtlSeconds(BigInt(batch.amount), currentPrice)
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

  async function attachExisting() {
    const myAttempt = ++attempt
    phase = 'pending'
    pendingLabel = 'Looking up the batch…'
    const driveName = name.trim() || undefined
    try {
      // A pasted signer key attaches an externally-owned batch; otherwise derive
      // this account's signer from its (plaintext) derivation key.
      const signerKey = pastedSignerKey
        ? new PrivateKey(strip0x(pastedSignerKey))
        : (await derivePostageSigner(account.derivationKey)).signerKey
      // Read the batch straight from the PostageStamp contract on-chain, not the
      // Bee node — a public gateway has no /stamps and won't know a batch bought
      // independently of it.
      const stamp = await fetchExistingBatchFromChain(batchIdInput.trim(), signerKey, driveName)
      if (myAttempt !== attempt) {
        return
      }
      if (!stamp) {
        errorMessage =
          'Couldn’t find that batch on chain. Check the Batch ID, or the Gnosis RPC endpoint in Network settings.'
        phase = 'error'
        return
      }
      // Existence isn't enough — upload one stamped test chunk to prove the
      // signer key can actually stamp uploads for this batch before attaching.
      pendingLabel = 'Verifying the batch…'
      const stampable = await verifyBatchStampable(stamp.batchID, signerKey, stamp.depth)
      if (myAttempt !== attempt) {
        return
      }
      if (!stampable) {
        errorMessage =
          'That batch exists, but this signer key can’t stamp uploads for it. Check the signer key.'
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

{#if phase === 'pending' || phase === 'error'}
  <DriveDialogStatus
    title="Add drive"
    {phase}
    {pendingLabel}
    {errorMessage}
    cancellable
    onRetry={() => ((phase = 'form'), (errorMessage = ''))}
    onClose={close}
  />
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
{:else}
  <Dialog onclose={close} title="Add drive">
    <div class="flex w-full flex-col gap-2">
      <label for="drive-name" class="text-sm font-medium">Name</label>
      <Input id="drive-name" bind:value={name} placeholder="Optional" />
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
        <Input
          id="drive-batch"
          bind:value={batchIdInput}
          placeholder="64-character hex"
          class="font-mono"
        />
        <p class="text-muted-foreground text-xs">Don't reuse batches across accounts.</p>
      </div>

      <div class="flex w-full flex-col gap-2">
        <label for="drive-signer" class="text-sm font-medium">Signer key (optional)</label>
        <Input
          id="drive-signer"
          bind:value={signerKeyInput}
          placeholder="64-character hex"
          class="font-mono"
        />
        <p class="text-muted-foreground text-xs">
          Leave blank to use this account's key. Paste the batch's private signer key to attach a
          batch owned by another key.
        </p>
      </div>
    {/if}

    <p class="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm">{infoText}</p>

    <Button class="w-full" disabled={!canProceed} onclick={proceed}>
      Proceed
      <ArrowRight />
    </Button>
  </Dialog>
{/if}
