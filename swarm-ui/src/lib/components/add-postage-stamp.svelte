<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import PostageStampForm from '$lib/components/postage-stamp-form.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Loader from '$lib/components/ui/loader.svelte'
  import ErrorMessage from '$lib/components/ui/error-message.svelte'
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
  import Launch from 'carbon-icons-svelte/lib/Launch.svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { BatchId, PrivateKey } from '@ethersphere/bee-js'
  import {
    openStampPurchaseWidget,
    generateSignerKey,
    type BatchEvent,
  } from '$lib/services/multichain-widget'
  import type { PostageStamp } from '@swarm-id/lib'

  const HEX_BASE = 16
  const SUCCESS_REDIRECT_DELAY_MS = 1500

  export type PageState = 'select' | 'purchase' | 'manual'
  export type PurchaseState = 'waiting' | 'success' | 'error'

  interface Props {
    accountId: string
    onSuccess: (stamp: PostageStamp) => void
    onSkip?: () => void
    skipText?: string
    introText?: string
    // Bindable state for parent to read
    pageState?: PageState
    purchaseState?: PurchaseState
    isFormDisabled?: boolean
  }

  let {
    accountId,
    onSuccess,
    onSkip,
    skipText = 'Skip this step',
    introText = 'Synced accounts require a Swarm postage stamp.',
    pageState = $bindable<PageState>('select'),
    purchaseState = $bindable<PurchaseState>('waiting'),
    isFormDisabled = $bindable(true),
  }: Props = $props()

  // Manual form state
  let batchID = $state('')
  let depth = $state(20)
  let signerKey = $state('')
  let amount = $state(0n)
  let blockNumber = $state(0)
  let submitError = $state<string | undefined>(undefined)

  // Purchase flow state
  let purchaseError = $state<string | undefined>(undefined)
  let signerKeyBytes = $state<Uint8Array | undefined>(undefined)

  export function goToSelect() {
    pageState = 'select'
    purchaseError = undefined
  }

  export function handleAddStamp() {
    submitError = undefined

    try {
      const stamp = postageStampsStore.addStamp({
        accountId,
        batchID: new BatchId(batchID),
        signerKey: new PrivateKey(signerKey),
        utilization: 0,
        usable: true,
        depth,
        amount,
        bucketDepth: 16,
        blockNumber,
        immutableFlag: false,
        exists: true,
      })

      onSuccess(stamp)
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Failed to add postage stamp'
    }
  }

  export function handlePurchase() {
    // Generate random signer key
    signerKeyBytes = generateSignerKey()
    const signerKeyPrivate = new PrivateKey(signerKeyBytes)

    // Derive destination address from signer key
    const destinationAddress = signerKeyPrivate.publicKey().address().toHex()

    // Update state
    pageState = 'purchase'
    purchaseState = 'waiting'
    purchaseError = undefined

    // Open widget
    openStampPurchaseWidget({
      destination: `0x${destinationAddress}`,
      onSuccess: handleWidgetSuccess,
      onError: handleWidgetError,
      onCancel: handleWidgetCancel,
      // Use mocked mode in development
      mocked: import.meta.env.DEV,
    })
  }

  function handleWidgetSuccess(batch: BatchEvent) {
    if (!signerKeyBytes) {
      purchaseState = 'error'
      purchaseError = 'Signer key not found'
      return
    }

    try {
      // Create postage stamp from widget response
      const stamp = postageStampsStore.addStamp({
        accountId,
        batchID: new BatchId(batch.batchId),
        signerKey: new PrivateKey(signerKeyBytes),
        depth: batch.depth,
        amount: BigInt(batch.amount),
        blockNumber: parseInt(batch.blockNumber, HEX_BASE),
        utilization: 0,
        usable: true,
        bucketDepth: 16,
        immutableFlag: false,
        exists: true,
      })

      purchaseState = 'success'

      // Call onSuccess after a short delay
      setTimeout(() => {
        onSuccess(stamp)
      }, SUCCESS_REDIRECT_DELAY_MS)
    } catch (error) {
      purchaseState = 'error'
      purchaseError = error instanceof Error ? error.message : 'Failed to save postage stamp'
    }
  }

  function handleWidgetError(error: Error) {
    purchaseState = 'error'
    purchaseError = error.message
  }

  function handleWidgetCancel() {
    // User cancelled - go back to select state
    pageState = 'select'
  }
</script>

{#if pageState === 'select'}
  <Vertical --vertical-gap="var(--double-padding)">
    <Typography>{introText}</Typography>

    <Horizontal --horizontal-gap="var(--padding)">
      <Button variant="strong" dimension="compact" flexGrow onclick={handlePurchase}>
        <Launch size={20} />
        Purchase new stamp
      </Button>
      <Button
        variant="secondary"
        dimension="compact"
        flexGrow
        onclick={() => (pageState = 'manual')}
      >
        Use existing one
        <ArrowRight size={20} />
      </Button>
    </Horizontal>

    {#if onSkip}
      <Typography variant="small">
        Not ready? <button class="link" onclick={onSkip}>{skipText}</button>.
      </Typography>
    {/if}
  </Vertical>
{:else if pageState === 'purchase'}
  {#if purchaseState === 'waiting'}
    <Vertical
      --vertical-gap="var(--padding)"
      --vertical-align-items="center"
      --vertical-justify-content="center"
      style="flex: 1;"
    >
      <Loader dimension="large" />
      <Typography center>Waiting for purchase to complete...</Typography>
      <Typography variant="small" center>
        Complete the purchase in the widget window. This page will update automatically.
      </Typography>
    </Vertical>
  {:else if purchaseState === 'success'}
    <Vertical
      --vertical-gap="var(--padding)"
      --vertical-align-items="center"
      --vertical-justify-content="center"
      style="flex: 1;"
    >
      <div class="success-icon">
        <Checkmark size={32} />
      </div>
      <Typography center>Stamp purchased successfully!</Typography>
      <Typography variant="small" center>
        Your new postage stamp has been saved and is ready to use.
      </Typography>
    </Vertical>
  {:else if purchaseState === 'error'}
    <Vertical
      --vertical-gap="var(--padding)"
      --vertical-align-items="center"
      --vertical-justify-content="center"
      style="flex: 1;"
    >
      <Typography center>Something went wrong during the purchase.</Typography>
      {#if purchaseError}
        <ErrorMessage>{purchaseError}</ErrorMessage>
      {/if}
    </Vertical>
  {/if}
{:else if pageState === 'manual'}
  <PostageStampForm
    bind:batchID
    bind:depth
    bind:amount
    bind:blockNumber
    bind:signerKey
    bind:disabled={isFormDisabled}
    {submitError}
  />
{/if}

<style>
  .link {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }

  .success-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--colors-green);
    color: var(--colors-base);
  }
</style>
