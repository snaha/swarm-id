<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import PostageStampForm from '$lib/components/postage-stamp-form.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Loader from '$lib/components/ui/loader.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import Launch from 'carbon-icons-svelte/lib/Launch.svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { BatchId, PrivateKey } from '@ethersphere/bee-js'
  import { openStampPurchaseWidget, type BatchEvent } from '$lib/services/multichain-widget'
  import { derivePostageSignerKey, hexToUint8Array } from '@snaha/swarm-id'
  import type { PostageStamp } from '@snaha/swarm-id'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { EthAddress } from '@ethersphere/bee-js'
  import { devSettingsStore } from '$lib/stores/dev-settings.svelte'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'

  const POLYCON_SIZE = 80

  // Parse a block number that may arrive as a 0x-hex string ("0x2a828b8") or a
  // decimal string/number from the widget. `Number()` handles both 0x-prefixed
  // hex and decimal; fall back to 0 if it isn't parseable.
  function parseBlockNumber(value: string): number {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }

  export type PageState = 'select' | 'purchase' | 'manual'
  export type PurchaseState = 'waiting' | 'success' | 'error' | 'unconfirmed'
  export type StampVariant = 'account-creation' | 'dashboard' | 'external-app'

  interface Props {
    accountId: string
    identityId?: string
    onSuccess: (stamp: PostageStamp) => void
    onSkip?: () => void
    introText?: string
    // Variant determines success/error screen layout
    variant?: StampVariant
    // For account-creation variant
    identityName?: string
    identityValue?: string
    // Bindable state for parent to read
    pageState?: PageState
    purchaseState?: PurchaseState
    isFormDisabled?: boolean
    // When true, call onSuccess immediately after purchase (skip success screen)
    autoNavigateOnSuccess?: boolean
  }

  let {
    accountId,
    identityId,
    onSuccess,
    onSkip,
    introText = 'Synced accounts require a Swarm postage stamp.',
    variant = 'dashboard',
    identityName,
    identityValue,
    pageState = $bindable<PageState>('select'),
    purchaseState = $bindable<PurchaseState>('waiting'),
    isFormDisabled = $bindable(true),
    autoNavigateOnSuccess = false,
  }: Props = $props()

  // Saved stamp reference for success screen navigation
  let savedStamp = $state<PostageStamp | undefined>(undefined)

  // Manual form state
  let batchID = $state('')
  let depth = $state(20)
  let signerKey = $state('')
  let amount = $state(0n)
  let blockNumber = $state(0)
  let submitError = $state<string | undefined>(undefined)

  // Purchase flow state
  let signerKeyBytes = $state<Uint8Array | undefined>(undefined)
  // Derived signer key (hex) for the just-attempted purchase, so an unconfirmed
  // close can pre-fill the manual recovery form — the user only needs the batch
  // ID the widget showed, not the (derived) signer key.
  let derivedSignerKeyHex = $state('')

  export function goToSelect() {
    pageState = 'select'
  }

  export function handleAddStamp() {
    submitError = undefined

    try {
      const stamp = postageStampsStore.addStamp(
        {
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
        },
        accountId,
      )

      onSuccess(stamp)
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Failed to add postage stamp'
      console.error(submitError, { error })
    }
  }

  export async function handlePurchase() {
    // Derive signer key from account's derivation key
    const account = accountsStore.getAccount(new EthAddress(accountId))
    if (!account) {
      console.error('[AddPostageStamp] Account not found', accountId)
      return
    }
    const signerKeyHex = await derivePostageSignerKey(account.derivationKey, identityId)
    signerKeyBytes = hexToUint8Array(signerKeyHex)
    derivedSignerKeyHex = signerKeyHex
    const signerKeyPrivate = new PrivateKey(signerKeyBytes)

    // Derive destination address from signer key
    const destinationAddress = signerKeyPrivate.publicKey().address().toHex()

    // Update state
    pageState = 'purchase'
    purchaseState = 'waiting'

    // Open widget
    openStampPurchaseWidget({
      destination: `0x${destinationAddress}`,
      onSuccess: handleWidgetSuccess,
      onError: handleWidgetError,
      onCancel: handleWidgetCancel,
      onUnconfirmedClose: handleWidgetUnconfirmedClose,
      mocked: devSettingsStore.data.mockStampEnabled,
      mockError: devSettingsStore.data.mockStampResult === 'error',
    })
  }

  function handleWidgetSuccess(batch: BatchEvent) {
    if (!signerKeyBytes) {
      purchaseState = 'error'
      return
    }

    try {
      // Create postage stamp from widget response
      const stamp = postageStampsStore.addStamp(
        {
          batchID: new BatchId(batch.batchId),
          signerKey: new PrivateKey(signerKeyBytes),
          depth: batch.depth,
          amount: BigInt(batch.amount),
          blockNumber: parseBlockNumber(batch.blockNumber),
          utilization: 0,
          usable: true,
          bucketDepth: 16,
          immutableFlag: false,
          exists: true,
        },
        accountId,
      )

      // In auto-navigate mode, call onSuccess immediately (skip success screen)
      if (autoNavigateOnSuccess) {
        onSuccess(stamp)
        return
      }

      // Otherwise, show success screen
      savedStamp = stamp
      purchaseState = 'success'
    } catch (error) {
      purchaseState = 'error'
      console.error(error instanceof Error ? error.message : 'Failed to add postage stamp', {
        error,
      })
    }
  }

  export function handleContinue() {
    if (savedStamp) {
      onSuccess(savedStamp)
    }
  }

  function handleWidgetError(error: Error) {
    purchaseState = 'error'
    console.error(error.message, { error })
  }

  function handleWidgetCancel() {
    // User explicitly backed out of the widget - go back to select state.
    pageState = 'select'
  }

  function handleWidgetUnconfirmedClose() {
    // The popup closed without a recognized batch event. The on-chain purchase
    // may have succeeded (e.g. the widget didn't auto-close and the user closed
    // it manually), so do NOT silently revert to 'select' and discard it —
    // surface a recovery state instead.
    purchaseState = 'unconfirmed'
  }

  function goToManualRecovery() {
    // Pre-fill the derived signer key so the user only needs the batch ID the
    // widget showed for the just-attempted purchase.
    signerKey = derivedSignerKeyHex
    pageState = 'manual'
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
        Not ready? <button class="link" onclick={onSkip}>Skip this step</button>.
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
      {#if variant === 'account-creation' && identityValue}
        <Polycon value={identityValue} size={POLYCON_SIZE} />
        {#if identityName}
          <Typography variant="small" center>{identityName}</Typography>
        {/if}
      {/if}

      <Typography variant="h4" center>
        {#if variant === 'account-creation'}
          ✅ All set!
        {:else if variant === 'external-app'}
          ✅ Upgrade successful!
        {:else}
          ✅ Upgrade successful
        {/if}
      </Typography>

      <Typography center>
        {#if variant === 'account-creation'}
          Your Swarm identity is ready to use.
        {:else if variant === 'external-app'}
          Your postage stamp was added to your account
        {:else}
          Your postage stamp is ready to use with your account.
        {/if}
      </Typography>

      {#if variant === 'account-creation'}
        <Typography variant="small" center class="footer-text">
          Manage your account and create more identities at
          <a href={resolve(routes.ROOT)} target="_blank">{window.location.hostname}</a>
        </Typography>
      {/if}
    </Vertical>
  {:else if purchaseState === 'error'}
    <Vertical
      --vertical-gap="var(--padding)"
      --vertical-align-items="center"
      --vertical-justify-content="center"
      style="flex: 1;"
    >
      <Typography variant="h4" center>‼️ Something went wrong</Typography>
      <Typography center>An unexpected error occurred. Please try again.</Typography>
    </Vertical>
  {:else if purchaseState === 'unconfirmed'}
    <Vertical
      --vertical-gap="var(--padding)"
      --vertical-align-items="center"
      --vertical-justify-content="center"
      style="flex: 1;"
    >
      <Typography variant="h4" center>⚠️ Purchase not confirmed</Typography>
      <Typography center>
        The window closed before we could confirm your purchase. If you completed it, your stamp was
        created — add it here using the batch ID the widget showed.
      </Typography>
      <Horizontal --horizontal-gap="var(--padding)">
        <Button variant="strong" dimension="compact" flexGrow onclick={goToManualRecovery}>
          Enter batch ID
        </Button>
        <Button
          variant="secondary"
          dimension="compact"
          flexGrow
          onclick={() => (pageState = 'select')}
        >
          Back to options
        </Button>
      </Horizontal>
    </Vertical>
  {/if}
{:else if pageState === 'manual'}
  <Vertical --vertical-gap="var(--double-padding)">
    <Typography>
      Please enter postage stamp details. If you don't have one, you can <button
        class="link"
        onclick={handlePurchase}>purchase a new stamp</button
      >.
    </Typography>
    <PostageStampForm
      bind:batchID
      bind:depth
      bind:amount
      bind:blockNumber
      bind:signerKey
      bind:disabled={isFormDisabled}
      {submitError}
    />
  </Vertical>
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

  :global(.footer-text) {
    opacity: 0.6;
  }
</style>
