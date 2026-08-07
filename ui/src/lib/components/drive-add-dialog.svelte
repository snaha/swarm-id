<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onDestroy } from 'svelte'

  import { PrivateKey, Utils } from '@ethersphere/bee-js'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import { BatchIdSchema, PrivateKeySchema } from '@snaha/swarm-id'

  import { createAttemptTracker } from '$lib/attempt'
  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
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
  import { runPurchase } from '$lib/payment/drive-operation'
  import {
    PaymentCancelledError,
    createFundingRequester,
    describeStep,
  } from '$lib/payment/funding-request.svelte'
  import { derivePostageSigner, stampAmountForSeconds, stampCostBzz } from '$lib/payment/purchase'
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
  type Phase = 'form' | 'pending' | 'success' | 'error'

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
  let errorDetail = $state('')

  let currentPrice = $state<bigint | undefined>(undefined)
  // Superseded on cancel/close so a late ceremony or widget callback can't complete.
  const attempts = createAttemptTracker()
  const funding = createFundingRequester(() => account)
  // In-flight widget purchase; cancelled on close so the popup can't settle a
  // payment we would silently drop.

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
    attempts.supersede()
    funding.cancel()
    onClose()
  }

  // The dialog can unmount without close() (tab switch, navigation) — abandon
  // any pending payment request so nothing is left waiting on a dialog that no
  // longer exists.
  onDestroy(() => funding.cancel())

  function proceed() {
    errorMessage = ''
    // The batch owner is a deterministic function of the account's (plaintext)
    // derivation key, so no unlock is needed — buying spends real money, and
    // the payment screens are confirmation enough.
    if (storage === 'existing') {
      void attachExisting()
    } else {
      void purchaseNew()
    }
  }

  async function purchaseNew() {
    const attempt = attempts.begin()
    phase = 'pending'
    pendingLabel = 'Checking the chain…'
    try {
      // Deliberately unguarded from here: this is an on-chain spend whose
      // record must land even if the dialog closed. Only the UI epilogue is
      // gated on `attempt.current`.
      await runPurchase({
        account,
        depth: Number(depthValue),
        lifespanSeconds,
        // Left blank, the drive stays unnamed and the UI falls back to its
        // stable batch-ID-derived label.
        name: name.trim(),
        requestFunding: funding.request,
        onStep: (step) => (pendingLabel = describeStep(step, 'purchase')),
      })
      if (!attempt.current) {
        return
      }
      succeed()
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      // Backing out of the payment is a choice, not a failure — return to the
      // form with the selection intact rather than reporting an error.
      if (caught instanceof PaymentCancelledError) {
        phase = 'form'
        return
      }
      errorDetail = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
      errorMessage = caught instanceof Error ? caught.message : 'Could not buy the drive.'
      phase = 'error'
    }
  }

  async function attachExisting() {
    const attempt = attempts.begin()
    phase = 'pending'
    pendingLabel = 'Looking up the batch…'
    const driveName = name.trim() || undefined
    try {
      // A pasted signer key attaches an externally-owned batch; otherwise derive
      // this account's signer from its (plaintext) derivation key.
      const signerKey = pastedSignerKey
        ? new PrivateKey(strip0x(pastedSignerKey))
        : (await attempt.guard(derivePostageSigner(account.derivationKey))).signerKey
      // Read the batch straight from the PostageStamp contract on-chain, not the
      // Bee node — a public gateway has no /stamps and won't know a batch bought
      // independently of it.
      const stamp = await attempt.guard(
        fetchExistingBatchFromChain(batchIdInput.trim(), signerKey, driveName),
      )
      if (!stamp) {
        errorMessage =
          'Couldn’t find that batch on chain. Check the Batch ID, or the Gnosis RPC endpoint in Network settings.'
        phase = 'error'
        return
      }
      // Existence isn't enough — upload one stamped test chunk to prove the
      // signer key can actually stamp uploads for this batch before attaching.
      pendingLabel = 'Verifying the batch…'
      const stampable = await attempt.guard(
        verifyBatchStampable(stamp.batchID, signerKey, stamp.depth),
      )
      if (!stampable) {
        errorMessage =
          'That batch exists, but this signer key can’t stamp uploads for it. Check the signer key.'
        phase = 'error'
        return
      }
      account.addStamp(stamp)
      succeed()
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      errorDetail = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
      errorMessage = caught instanceof Error ? caught.message : 'Could not add the drive.'
      phase = 'error'
    }
  }

  function succeed() {
    onAdded?.('Drive added')
    close()
  }
</script>

{#if funding.pending}
  <PaymentDialog
    need={funding.pending.need}
    rail={funding.pending.rail}
    fundingQuote={funding.pending.quote}
    onPaid={funding.resolve}
    onCancel={funding.cancel}
  />
{:else if phase === 'pending' || phase === 'error'}
  <DriveDialogStatus
    title="Add drive"
    {phase}
    {pendingLabel}
    {errorMessage}
    errorDetails={errorDetail}
    successTitle="Purchase completed!"
    successBody="Your drive is ready to use."
    cancellable
    onRetry={() => ((phase = 'form'), (errorMessage = ''))}
    onClose={close}
  />
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
