<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Input from '$lib/components/ui/input/input.svelte'
  import ErrorMessage from '$lib/components/ui/error-message.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import ResponsiveLayout from '$lib/components/ui/responsive-layout.svelte'
  import FormattedNumberInput from '$lib/components/ui/input/formatted-number/input.svelte'
  import FormattedBigintInput from '$lib/components/ui/input/formatted-bigint/input.svelte'

  interface Props {
    batchID: string
    depth: number
    amount: bigint
    blockNumber: number
    signerKey: string
    submitError?: string
    disabled?: boolean
  }

  let {
    batchID = $bindable(),
    depth = $bindable(),
    amount = $bindable(),
    blockNumber = $bindable(),
    signerKey = $bindable(),
    submitError,
    disabled = $bindable(true),
  }: Props = $props()

  // Error state for each field
  let batchIDError = $derived.by(() => {
    if (!batchID) return undefined
    if (batchID.length !== 64) return 'Stamp ID must be exactly 64 characters (hex)'
    if (!/^[0-9a-fA-F]{64}$/.test(batchID)) return 'Stamp ID must be a valid hex string'
    return undefined
  })

  let numberError = $derived.by(() => {
    if (isNaN(depth)) return 'Depth must be a number'
    if (depth < 17 || depth > 40) return 'Depth must be between 17 and 40'

    if (amount !== undefined && typeof amount !== 'bigint') return 'Amount must be a valid integer'
    if (amount !== undefined && amount < 0n) return 'Amount must be 0 or greater'

    if (isNaN(blockNumber)) return 'Block number must be a number'
    if (blockNumber < 0) return 'Block number must be 0 or greater'

    return undefined
  })

  let signerKeyError = $derived.by(() => {
    if (!signerKey) return undefined
    if (signerKey.length !== 64) return 'Signer key must be exactly 64 characters (hex)'
    if (!/^[0-9a-fA-F]{64}$/.test(signerKey)) return 'Signer key must be a valid hex string'
    return undefined
  })

  // Validation errors are surfaced only when focus leaves a field, never while
  // typing. These hold the error snapshot captured at blur (the derived *Error
  // values above stay live and drive `disabled`). Mutated only in focus handlers,
  // so typing in a field never changes its displayed error.
  let batchIDErrorShown = $state<string | undefined>(undefined)
  let numberErrorShown = $state<string | undefined>(undefined)
  let signerKeyErrorShown = $state<string | undefined>(undefined)

  // Snapshot the current error when focus leaves a field — but not when the whole
  // window loses focus (e.g. alt-tabbing to an editor to copy a value).
  function snapshotOnBlur(snapshot: () => void) {
    if (document.hasFocus()) snapshot()
  }

  $effect(() => {
    disabled =
      !batchID || !depth || !signerKey || !!batchIDError || !!numberError || !!signerKeyError
  })
</script>

<Vertical>
  <!-- Row 1 -->
  <div
    class="input-wrapper"
    onfocusin={() => (batchIDErrorShown = undefined)}
    onfocusout={() => snapshotOnBlur(() => (batchIDErrorShown = batchIDError))}
  >
    <Input
      variant="outline"
      dimension="compact"
      name="batchID"
      bind:value={batchID}
      error={batchIDErrorShown}
      label="Stamp ID"
      helperText="Don't reuse stamps across accounts and identities"
    />
  </div>
  {#if batchIDErrorShown}
    <div class="error-full-width">
      <ErrorMessage>{batchIDErrorShown}</ErrorMessage>
    </div>
  {/if}

  <!-- Row 2 -->
  <Vertical>
    <div
      onfocusin={() => (numberErrorShown = undefined)}
      onfocusout={() => snapshotOnBlur(() => (numberErrorShown = numberError))}
    >
      <ResponsiveLayout --responsive-justify-content="stretch">
        <FormattedNumberInput
          variant="outline"
          dimension="compact"
          name="depth"
          locale={undefined}
          bind:value={depth}
          label="Depth"
          class="flex-grow"
          min={0}
          max={255}
          step={1}
        />
        <FormattedBigintInput
          variant="outline"
          dimension="compact"
          name="amount"
          locale={undefined}
          bind:value={amount}
          label="Amount"
          class="flex-grow"
          min={0n}
        />
        <FormattedNumberInput
          variant="outline"
          dimension="compact"
          name="blockNumber"
          locale={undefined}
          bind:value={blockNumber}
          label="Block number"
          class="flex-grow"
          min={0}
          step={1}
        />
      </ResponsiveLayout>
    </div>
    {#if numberErrorShown}
      <div class="error-full-width">
        <ErrorMessage>{numberErrorShown}</ErrorMessage>
      </div>
    {/if}
  </Vertical>

  <!-- Row 3 -->
  <div
    class="input-wrapper"
    onfocusin={() => (signerKeyErrorShown = undefined)}
    onfocusout={() => snapshotOnBlur(() => (signerKeyErrorShown = signerKeyError))}
  >
    <Input
      variant="outline"
      dimension="compact"
      name="signerKey"
      bind:value={signerKey}
      error={signerKeyErrorShown}
      label="Signer key"
    />
  </div>
  {#if signerKeyErrorShown}
    <div class="error-full-width">
      <ErrorMessage>{signerKeyErrorShown}</ErrorMessage>
    </div>
  {/if}

  {#if submitError}
    <div class="error-full-width">
      <ErrorMessage>{submitError}</ErrorMessage>
    </div>
  {/if}
</Vertical>

<style>
  .input-wrapper :global(.error-message) {
    display: none;
  }

  .error-full-width {
    grid-column: 1 / -1;
  }
  :global(.flex-grow) {
    flex: 1;
    min-width: 0;
  }
</style>
