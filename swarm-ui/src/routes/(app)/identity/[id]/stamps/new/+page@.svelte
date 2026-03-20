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
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { PostageStamp } from '@swarm-id/lib'

  const identityId = $derived($page.params.id)
  const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
  const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)

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
    if (identity) {
      goto(resolve(routes.IDENTITY_STAMPS, { id: identity.id }))
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
    if (!identity || !account) return

    // If this account already has a default stamp, set this as the identity's default
    // Otherwise make it the account's default
    if (account.defaultPostageStampBatchID) {
      identitiesStore.setDefaultStamp(identity.id, stamp.batchID)
    } else {
      accountsStore.setDefaultStamp(account.id, stamp.batchID)
    }

    navigateBack()
  }

  // Derive intro text based on whether account has a default stamp
  const introText = $derived(
    account?.defaultPostageStampBatchID
      ? 'You chose to use a separate stamp for this identity.'
      : 'Synced accounts let you upload content to Swarm and access your account from any device.',
  )
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
