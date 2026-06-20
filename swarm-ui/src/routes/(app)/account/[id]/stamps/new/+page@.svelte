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
    type StampVariant,
  } from '$lib/components/add-postage-stamp.svelte'
  import AddPostageStampButtons from '$lib/components/add-postage-stamp-buttons.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/stores'
  import routes from '$lib/routes'
  import { EthAddress } from '@ethersphere/bee-js'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { PostageStamp } from '@snaha/swarm-id'

  const accountId = $derived($page.params.id)
  const account = $derived(
    accountId ? accountsStore.getAccount(new EthAddress(accountId)) : undefined,
  )

  // Determine variant based on whether user came from external app
  const appData = $derived(sessionStore.data.appData)
  const variant = $derived<StampVariant>(appData ? 'external-app' : 'dashboard')

  // Check if this is an upgrade (local account getting its first stamp)
  const isUpgrade = $derived(!account?.defaultPostageStampBatchID)

  function handleGoToApp() {
    window.close()
  }

  // Bindable state from AddPostageStamp component
  let pageState = $state<PageState>('select')
  let purchaseState = $state<PurchaseState>('waiting')
  let isFormDisabled = $state(true)

  // Reference to AddPostageStamp component
  let addPostageStampRef = $state<AddPostageStamp>()

  function navigateBack() {
    if (account) {
      goto(resolve(routes.ACCOUNT_STAMPS, { id: account.id.toHex() }))
    } else {
      history.back()
    }
  }

  function handleClose() {
    if (pageState === 'select') {
      navigateBack()
    } else {
      pageState = 'select'
    }
  }

  function handleSuccess(stamp: PostageStamp) {
    if (!account) return
    // AddPostageStamp already added the stamp to the account; make it the default
    // (the account default pays for account data + app uploads).
    accountsStore.setDefaultStamp(account.id, stamp.batchID)
    navigateBack()
  }

  const introText =
    'Synced accounts let you upload content to Swarm and access your account from any device.'
</script>

<CreationLayout
  title={isUpgrade ? 'Upgrade account' : 'Add postage stamp'}
  onClose={handleClose}
  fullPage
  busy={pageState === 'purchase'}
>
  {#snippet content()}
    {#if !account}
      <Typography>No account data found. Please start from the home page.</Typography>
    {:else}
      <AddPostageStamp
        bind:this={addPostageStampRef}
        accountId={account.id.toHex()}
        onSuccess={handleSuccess}
        onSkip={isUpgrade ? undefined : navigateBack}
        {introText}
        {variant}
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
        {variant}
        appName={appData?.appName}
        onGoToApp={handleGoToApp}
      />
    {/if}
  {/snippet}
</CreationLayout>
