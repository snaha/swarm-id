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
  import { createCostEstimate } from '$lib/payment/cost-estimate.svelte'
  import { PaymentCancelledError, runPurchase } from '$lib/payment/drive-operation'
  import { createFundingRequester, describeStep } from '$lib/payment/funding-request.svelte'
  import { type StampPurchaseHandle, openStampPurchaseWidget } from '$lib/payment/multichain-widget'
  import { operationJournal } from '$lib/payment/operation-journal.svelte'
  import {
    derivePostageSigner,
    stampAmountForSeconds,
    stampFromBatch,
    stampTtlSeconds,
  } from '$lib/payment/purchase'
  import type { Account } from '$lib/types'

  const STORAGE_OPTIONS = [
    { value: 'new', label: 'Purchase new batch' },
    { value: 'existing', label: 'Use existing batch' },
  ]

  /** The drive on the form was bought. */
  const BOUGHT_SUCCESS = {
    title: 'Purchase completed!',
    body: 'Your drive is ready to use.',
  }
  /**
   * A drive an earlier attempt had already paid for was finished instead — the
   * size, lifespan and name just chosen went unused, and saying "your drive is
   * ready to use" over that would describe a drive the user never bought.
   */
  const RESUMED_SUCCESS = {
    title: 'Earlier purchase completed',
    body: 'An unfinished drive from an earlier attempt was finished instead of buying a new one. No new payment was taken.',
  }

  interface Props {
    account: Account
    onClose: () => void
    onAdded?: (message: string) => void
  }

  let { account, onClose, onAdded }: Props = $props()

  type Storage = 'new' | 'existing'
  type Phase = 'form' | 'pending' | 'success' | 'error' | 'unconfirmed'

  let storage = $state<Storage>('new')
  let name = $state('')
  let depthValue = $state('')
  let lifespanValue = $state('1')
  let lifespanUnit = $state<LifespanUnit>('years')
  let batchIdInput = $state('')
  let signerKeyInput = $state('')

  let phase = $state<Phase>('form')
  let pendingLabel = $state('')
  // The steps already finished this attempt, so a failure says what was paid for.
  let history = $state<string[]>([])
  let errorMessage = $state('')
  let errorDetail = $state('')
  // Which ending the success screen describes; only a purchase reaches it.
  let success = $state(BOUGHT_SUCCESS)

  let currentPrice = $state<bigint | undefined>(undefined)
  // Superseded on cancel/close so a late ceremony or widget callback can't complete.
  const attempts = createAttemptTracker()
  const funding = createFundingRequester(() => account)
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

  /** Per-chunk PLUR the batch would be funded with at the current price. */
  const amountPerChunk = $derived.by(() => {
    if (
      storage !== 'new' ||
      depthValue === '' ||
      currentPrice === undefined ||
      lifespanSeconds <= 0
    ) {
      return undefined
    }
    return stampAmountForSeconds(currentPrice, lifespanSeconds)
  })

  const estimate = createCostEstimate(() =>
    amountPerChunk === undefined ? undefined : { depth: Number(depthValue), amountPerChunk },
  )

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
    return estimate.value ? `Estimated cost ~${estimate.value}` : 'Final cost is shown at payment.'
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
    purchase?.cancel()
    purchase = undefined
    onClose()
  }

  // The dialog can unmount without close() (tab switch, navigation) — abandon
  // any pending payment request so nothing is left waiting on a dialog that no
  // longer exists, and close the widget popup so it can't settle a payment we
  // would silently drop.
  onDestroy(() => {
    funding.cancel()
    purchase?.cancel()
  })

  function proceed() {
    errorMessage = ''
    errorDetail = ''
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
    history = []
    try {
      // Deliberately unguarded: `runPurchase` stops itself at its money
      // boundaries via `cancelled` below, and everything after the send is a
      // tail that must land even if the dialog closed — a paid-for batch has to
      // be recorded. Only the UI epilogue is gated on `attempt.current`.
      const result = await runPurchase({
        journal: operationJournal,
        account,
        depth: Number(depthValue),
        lifespanSeconds,
        // Left blank, the drive stays unnamed and the UI falls back to its
        // stable batch-ID-derived label.
        name: name.trim(),
        requestFunding: funding.request,
        cancelled: () => !attempt.current,
        onStep: (step) => {
          const next = describeStep(step, 'purchase')
          // The seeded label and the first step say the same thing; listing
          // both would tick a step off that never happened separately.
          if (pendingLabel && pendingLabel !== next) {
            history = [...history, pendingLabel]
          }
          pendingLabel = next
        },
      })
      if (!attempt.current) {
        return
      }
      purchased(result.resumedUnfinished)
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

  /**
   * The design's proven "Pay with crypto" method: hand the whole purchase to
   * the fund.bzz.limo widget popup instead of the in-app engine. Reached from
   * the payment screen's method picker, i.e. only once the in-app run found a
   * shortfall — a prefunded signer buys in-app without ever paying.
   */
  function payWithWidget() {
    void purchaseViaWidget()
  }

  async function purchaseViaWidget() {
    const attempt = attempts.begin()
    // Abandon the in-app run suspended on this funding request. Its rejection
    // lands in a catch gated on the attempt this begin() just superseded, so
    // the engine's epilogue cannot fight the widget flow for the dialog.
    funding.cancel()
    phase = 'pending'
    pendingLabel = 'Complete the purchase in the popup window.'
    history = []
    errorMessage = ''
    errorDetail = ''
    // Left blank, the drive stays unnamed and the UI falls back to its stable
    // batch-ID-derived label.
    const driveName = name.trim() || undefined
    try {
      // The user may have cancelled during the derivation — bail before the
      // popup opens, or a payment window would appear after they backed out.
      const { signerKey, destination } = await attempt.guard(
        derivePostageSigner(account.derivationKey),
      )
      purchase = openStampPurchaseWidget({
        destination,
        onSuccess: (batch) => {
          if (!attempt.current) {
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
          // The widget settles the batch it was opened for, never an orphan.
          purchased(false)
        },
        onError: (error) => {
          if (!attempt.current) {
            return
          }
          errorMessage = error.message
          phase = 'error'
        },
        onCancel: () => {
          if (attempt.current) {
            phase = 'form'
          }
        },
        onUnconfirmedClose: () => {
          if (attempt.current) {
            phase = 'unconfirmed'
          }
        },
      })
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      errorMessage = caught instanceof Error ? caught.message : 'Could not start the purchase.'
      phase = 'error'
    }
  }

  async function attachExisting() {
    const attempt = attempts.begin()
    phase = 'pending'
    pendingLabel = 'Looking up the batch…'
    history = []
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
        // No exception behind this one — and no stale stack from an earlier
        // failure either, which "View details" would otherwise offer as if it
        // belonged to it.
        errorDetail = ''
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
        errorDetail = ''
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

  /**
   * A purchase settled. Money moved, so the flow stops on the success screen
   * and says what it bought, rather than vanishing behind a toast — which is
   * what the screen was designed for and never reached.
   */
  function purchased(resumedUnfinished: boolean) {
    success = resumedUnfinished ? RESUMED_SUCCESS : BOUGHT_SUCCESS
    phase = 'success'
  }

  /**
   * Announce the drive and leave: the success screen's Close, and the whole
   * ending for an attach, which spends nothing and has nothing to confirm.
   */
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
    onPayWithWidget={payWithWidget}
  />
{:else if phase === 'pending' || phase === 'success' || phase === 'error'}
  <DriveDialogStatus
    title="Add drive"
    {phase}
    {pendingLabel}
    {history}
    {errorMessage}
    errorDetails={errorDetail}
    successTitle={success.title}
    successBody={success.body}
    cancellable
    onRetry={() => ((phase = 'form'), (errorMessage = ''), (errorDetail = ''))}
    onClose={phase === 'success' ? succeed : close}
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
