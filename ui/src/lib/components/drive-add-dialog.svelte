<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onDestroy } from 'svelte'

  import { PrivateKey } from '@ethersphere/bee-js'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { BatchIdSchema, PrivateKeySchema } from '@snaha/swarm-id'

  import { type Attempt, createAttemptTracker } from '$lib/attempt'
  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { strip0x } from '$lib/crypto/hex'
  import {
    DRIVE_SIZE_BREAKPOINTS,
    LIFESPAN_UNIT_OPTIONS,
    type LifespanUnit,
    formatBytes,
    lifespanToSeconds,
  } from '$lib/drives'
  import { failureDetail } from '$lib/failure-detail'
  import { verifyBatchStampable } from '$lib/payment/bee'
  import { currentChainPrice } from '$lib/payment/chain-price'
  import { fetchExistingBatchFromChain } from '$lib/payment/contract'
  import { createCostEstimate } from '$lib/payment/cost-estimate.svelte'
  import { runPurchase } from '$lib/payment/drive-operation'
  import {
    PaymentCancelledError,
    UseWidgetError,
    createFundingRequester,
    describeStep,
  } from '$lib/payment/funding-request.svelte'
  import { type StampPurchaseHandle, openStampPurchaseWidget } from '$lib/payment/multichain-widget'
  import {
    BUILT_IN_EXPLAINER,
    BUILT_IN_LABEL,
    type PaymentMethod,
    WIDGET_EXPLAINER,
    WIDGET_LABEL,
  } from '$lib/payment/payment-method'
  import {
    derivePostageSigner,
    stampAmountForSeconds,
    stampFromBatch,
    stampTtlSeconds,
  } from '$lib/payment/purchase'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
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
  type Phase = 'form' | 'method' | 'pending' | 'success' | 'error' | 'unconfirmed'

  const METHOD_OPTIONS = [
    { value: 'widget', label: WIDGET_LABEL },
    { value: 'built-in', label: BUILT_IN_LABEL },
  ]

  let storage = $state<Storage>('new')
  let name = $state('')
  let depthValue = $state('')
  let lifespanValue = $state('1')
  let lifespanUnit = $state<LifespanUnit>('years')
  let batchIdInput = $state('')
  let signerKeyInput = $state('')

  let phase = $state<Phase>('form')
  /**
   * The route the purchase takes, chosen BEFORE anything reads the chain.
   *
   * The funding seam used to be the only place this could be asked, and it is
   * raised only when the owner address is short (#619) — so an account holding
   * funds from an earlier attempt was committed to the built-in engine with no
   * way to say otherwise, and a purchase that could not reach the chain at all
   * failed before the question was ever put. Asking here precedes both.
   */
  let method = $state<PaymentMethod>('widget')
  let pendingLabel = $state('')
  let errorMessage = $state('')
  let errorDetail = $state('')

  let currentPrice = $state<bigint | undefined>(undefined)
  // Superseded on cancel/close so a late ceremony or widget callback can't complete.
  const attempts = createAttemptTracker()
  const funding = createFundingRequester(() => account)
  // In-flight widget purchase; cancelled on close so the popup can't settle a
  // payment we would silently drop.
  let purchase: StampPurchaseHandle | undefined

  const sizeOptions = [
    { value: '', label: 'Please select' },
    ...DRIVE_SIZE_BREAKPOINTS.map(([depth, bytes]) => ({
      value: String(depth),
      label: formatBytes(bytes),
    })),
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
    return estimate.value ? `Estimated cost ≈ ${estimate.value}` : 'Final cost is shown at payment.'
  })

  // Best-effort: the price only feeds the cost estimate here (and the TTL guess
  // for a settled purchase); the purchase itself never gates on it.
  $effect(() => {
    currentChainPrice()
      .then((price) => (currentPrice = price))
      .catch(() => undefined)
  })

  /**
   * Stop tracking the widget purchase. Cancelling once money is in flight leaves
   * the popup running — killing it would strand the funds — so that exit is
   * otherwise silent: no callback fires, and a batch settling afterwards lands
   * nowhere. This dialog is the last place that can say so, hence the toast.
   * A settled purchase says nothing: the batch is recorded and only the widget's
   * trailing sweep is left.
   */
  function abandonPurchase() {
    const stillPaying = purchase?.cancel()
    purchase = undefined
    if (stillPaying) {
      toastStore.show(
        'Payment is still finishing in the widget window. If the drive does not appear, add it with “Use existing batch”.',
      )
    }
  }

  /**
   * Let go of everything still in flight, leaving the dialog on screen. A
   * settled purchase uses this to stop a late widget callback or ceremony from
   * writing over the success screen the user is looking at.
   */
  function release() {
    attempts.supersede()
    funding.cancel()
    abandonPurchase()
  }

  /**
   * Back to the form for another go, letting go of the failed run first. A
   * funding request stays armed once its payment lands — a cancel from there
   * would cost the user money — and nothing lowers it when the operation ends,
   * so without this the retry inherits `armed` from the run that already
   * failed. The next attempt then renders with no Cancel whichever route it
   * takes, including the widget, which never goes near the rail at all.
   */
  function retry() {
    release()
    phase = 'form'
  }

  function close() {
    release()
    // Whichever way the success screen is dismissed — Done, Esc, the backdrop —
    // is the point the drive counts as added: `onAdded` is the toast for some
    // callers and the "continue" step of onboarding for others, so it must fire
    // exactly once, here.
    if (phase === 'success') {
      onAdded?.('Drive added')
    }
    onClose()
  }

  // The dialog can unmount without close() (tab switch, navigation) — abandon
  // any pending payment request so nothing is left waiting on a dialog that no
  // longer exists, and cancel a widget popup so its poll and message listener
  // don't outlive us. A payment already with the wallet is not abandoned by
  // this: the requester keeps that one armed, and its own outcome settles it.
  // After a `close()` the cancel is a no-op — it is terminal — so this neither
  // re-cancels nor toasts twice.
  onDestroy(() => {
    funding.cancel()
    abandonPurchase()
  })

  function proceed() {
    errorMessage = ''
    // Cleared with the message it belongs to: a later failure that sets only
    // `errorMessage` would otherwise put the previous run's detail behind "View
    // details".
    errorDetail = ''
    // The batch owner is a deterministic function of the account's (plaintext)
    // derivation key, so no unlock is needed — buying spends real money, and
    // the payment screens are confirmation enough.
    if (storage === 'existing') {
      void attachExisting()
      return
    }
    // The method first, and before any chain read: `runPurchase` opens with the
    // contract's constraints and the owner's balance, and each of those can end
    // the purchase — one by throwing, the other by covering the cost — with the
    // question still unasked (#619).
    phase = 'method'
  }

  /** Start the purchase on the method the chooser is on. */
  function startPurchase() {
    if (method === 'widget') {
      void purchaseWithWidget(attempts.begin())
      return
    }
    void purchaseNew()
  }

  async function purchaseNew() {
    const attempt = attempts.begin()
    phase = 'pending'
    pendingLabel = 'Checking the chain…'
    try {
      // `beforeSpend` is where a cancel lands: it throws `SupersededError`
      // once this attempt is stale, so the pre-spend chain reads abort with
      // nothing bought — including when the owner address already holds funds
      // and no payment screen ever opened to cancel through. Everything AFTER
      // it is deliberately unguarded: the batch is paid for, so its record must
      // land even if the dialog closed. Only the UI epilogue is gated on
      // `attempt.current`.
      await runPurchase({
        account,
        depth: Number(depthValue),
        lifespanSeconds,
        // Left blank, the drive stays unnamed and the UI falls back to its
        // stable batch-ID-derived label.
        name: name.trim(),
        requestFunding: funding.request,
        beforeSpend: () => attempt.guard(Promise.resolve()),
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
      // The method screen handed the payment to the multichain widget. The engine
      // operation is abandoned with nothing spent — the funding seam is raised
      // before any spend — so carry on with the widget on the same attempt,
      // which a close still supersedes.
      if (caught instanceof UseWidgetError) {
        void purchaseWithWidget(attempt)
        return
      }
      // Backing out of the payment is a choice, not a failure — return to the
      // form with the selection intact rather than reporting an error.
      if (caught instanceof PaymentCancelledError) {
        phase = 'form'
        return
      }
      errorDetail = failureDetail(caught)
      errorMessage = caught instanceof Error ? caught.message : 'Could not buy the drive.'
      phase = 'error'
    }
  }

  /**
   * Buy the drive through the multichain-widget popup, which settles the payment
   * and creates the batch itself and hands back the finished thing. Nothing
   * here goes near the rail or the on-chain engine. (The popup is served from
   * `swarmbucks.eth.limo` since this PR — the UI copy elsewhere still says
   * `fund.bzz.limo`, which is the older deployment of the same widget.)
   */
  async function purchaseWithWidget(attempt: Attempt) {
    // Release whatever is still open before taking a new handle. Every route in
    // releases first, so this is a no-op today; it sits at the assignment so a
    // new one can't silently orphan a live popup, which nothing could cancel
    // afterwards. `abandonPurchase()` and not `release()` — that also supersedes
    // the attempt, which the `UseWidgetError` route carries in.
    abandonPurchase()
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
      // The user may have cancelled during the derivation — bail before the
      // popup opens, or a payment window would appear after they backed out.
      const { signerKey, destination } = await attempt.guard(
        derivePostageSigner(account.derivationKey),
      )
      purchase = openStampPurchaseWidget({
        destination,
        // /dev mock (see dev-settings): simulate the purchase without a real
        // cross-chain payment. No-op in production, where the toggle is off.
        mocked: devSettingsStore.data.mockStampEnabled,
        mockPopup: devSettingsStore.data.mockStampPopup,
        mockError: devSettingsStore.data.mockStampResult === 'error',
        // Only the mock can honour this — the real widget picks the size itself.
        mockDepth: depthValue === '' ? undefined : Number(depthValue),
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
          succeed()
        },
        onError: (error) => {
          if (!attempt.current) {
            return
          }
          errorDetail = failureDetail(error)
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
      errorDetail = failureDetail(caught)
      errorMessage = caught instanceof Error ? caught.message : 'Could not start the purchase.'
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
      errorDetail = failureDetail(caught)
      errorMessage = caught instanceof Error ? caught.message : 'Could not add the drive.'
      phase = 'error'
    }
  }

  /**
   * Stay on screen and say so, the way extending and resizing do. `onAdded`
   * waits for the user to dismiss that screen — see `close`.
   */
  function succeed() {
    release()
    phase = 'success'
  }
</script>

{#if funding.pending}
  <PaymentDialog
    need={funding.pending.need}
    rail={funding.pending.rail}
    onPaid={funding.resolve}
    onCancel={funding.cancel}
    onUseWidget={() => funding.cancel({ reason: 'use-widget' })}
    initialMethod="built-in"
  />
{:else if phase === 'unconfirmed'}
  <Dialog onclose={close} title="Purchase not confirmed">
    <div class="flex items-start gap-2">
      <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      <p class="text-sm">
        Your payment went through, but the payment window closed before the purchase was confirmed.
        The drive may still appear shortly — don't pay again without checking.
      </p>
    </div>
    <Button variant="outline" class="w-full" onclick={close}>Close</Button>
  </Dialog>
{:else if phase === 'method'}
  <Dialog onclose={close} title="Payment">
    {#snippet leading()}
      <Button
        variant="ghost"
        size="icon"
        class="-mt-1.5 -ml-1.5 size-6 rounded-md [&_svg]:size-3.5"
        aria-label="Back"
        onclick={() => (phase = 'form')}
      >
        <ArrowLeft />
      </Button>
    {/snippet}

    <div class="flex w-full flex-col gap-2">
      <span class="text-sm font-medium">Method</span>
      <Select options={METHOD_OPTIONS} bind:value={method} />
    </div>

    <p class="bg-muted rounded-md px-3 py-2 text-sm">
      {method === 'widget' ? WIDGET_EXPLAINER : BUILT_IN_EXPLAINER}
    </p>

    <!-- The widget's label matches the one on `PaymentDialog`'s own method
         screen: the same route reached from either place must read as the same
         route. -->
    <Button class="w-full" onclick={startPurchase}>
      {method === 'widget' ? 'Continue to fund.bzz.limo' : 'Continue'}
      <ArrowRight />
    </Button>
  </Dialog>
{:else if phase === 'pending' || phase === 'success' || phase === 'error'}
  <!-- Cancel only while nothing has been paid for. Once a funding request is
       armed the money is with the wallet or already swapped, and cancelling
       would supersede the attempt at `beforeSpend` — leaving the user paid up
       with no drive and, being `attempt.current`-gated, nothing on screen to
       say so. The early "Checking the chain…" phase keeps its Cancel: aborting
       there spends nothing. -->
  <DriveDialogStatus
    title="Add drive"
    {phase}
    {pendingLabel}
    {errorMessage}
    errorDetails={errorDetail}
    successTitle="Purchase completed!"
    successBody="Your drive is ready to use."
    cancellable={!funding.armed}
    onRetry={retry}
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
