<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Typography from '$lib/components/ui/typography.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import AddPostageStamp, {
    type PageState,
    type PurchaseState,
  } from '$lib/components/add-postage-stamp.svelte'
  import AddPostageStampButtons from '$lib/components/add-postage-stamp-buttons.svelte'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { PostageStamp } from '@snaha/swarm-id'

  const account = $derived(sessionStore.data.account)
  const appData = $derived(sessionStore.data.appData)

  // Bindable state from AddPostageStamp component
  let pageState = $state<PageState>('select')
  let purchaseState = $state<PurchaseState>('waiting')
  let isFormDisabled = $state(true)

  // Reference to AddPostageStamp component
  let addPostageStampRef = $state<AddPostageStamp>()

  function handleSkip() {
    navigateToConnectOrHome()
  }

  function handleClose() {
    if (pageState === 'select') {
      navigateToConnectOrHome()
    } else {
      pageState = 'select'
    }
  }

  function handleSuccess(stamp: PostageStamp) {
    if (!account) return
    // AddPostageStamp already added the stamp; make it the account default.
    accountsStore.setDefaultStamp(account.id, stamp.batchID)
    navigateToConnectOrHome()
  }
</script>

<CreationLayout title="Add postage stamp" onClose={handleClose} busy={pageState === 'purchase'}>
  {#snippet content()}
    {#if !account}
      <Typography>No account data found. Please start from the home page.</Typography>
    {:else}
      <AddPostageStamp
        bind:this={addPostageStampRef}
        accountId={account.id.toHex()}
        onSuccess={handleSuccess}
        onSkip={handleSkip}
        introText="Synced accounts require a Swarm postage stamp."
        variant="account-creation"
        accountName={account.name}
        accountValue={account.id.toHex()}
        autoNavigateOnSuccess={!!appData}
        bind:pageState
        bind:purchaseState
        bind:isFormDisabled
      />
    {/if}
  {/snippet}

  {#snippet buttonContent()}
    {#if account && addPostageStampRef}
      <AddPostageStampButtons
        {pageState}
        {purchaseState}
        {isFormDisabled}
        stampRef={addPostageStampRef}
        variant="account-creation"
        onSkip={handleSkip}
      />
    {/if}
  {/snippet}
</CreationLayout>
