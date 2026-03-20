<script lang="ts">
  import Typography from '$lib/components/ui/typography.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import AddPostageStamp, {
    type PageState,
    type PurchaseState,
  } from '$lib/components/add-postage-stamp.svelte'
  import AddPostageStampButtons from '$lib/components/add-postage-stamp-buttons.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { PostageStamp } from '@swarm-id/lib'

  const account = $derived(sessionStore.data.account)
  const currentIdentityId = $derived(sessionStore.data.currentIdentityId)
  const identity = $derived(
    currentIdentityId ? identitiesStore.getIdentity(currentIdentityId) : undefined,
  )
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

    // Set as default stamp for the account
    accountsStore.setDefaultStamp(account.id, stamp.batchID)

    // If user chose separate stamps, go to identity stamp page next
    if (sessionStore.data.selectedStampOption === 'separate') {
      goto(resolve(routes.STAMPS_IDENTITY_NEW))
      return
    }

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
        identityName={identity?.name}
        identityValue={identity?.id}
        autoNavigateOnSuccess={!!appData || sessionStore.data.selectedStampOption === 'separate'}
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
