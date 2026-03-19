<script lang="ts">
  import Typography from '$lib/components/ui/typography.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import AddPostageStamp, {
    type PageState,
    type PurchaseState,
  } from '$lib/components/add-postage-stamp.svelte'
  import AddPostageStampButtons from '$lib/components/add-postage-stamp-buttons.svelte'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
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

  function handleClose() {
    if (pageState === 'select') {
      navigateToConnectOrHome()
    } else {
      pageState = 'select'
    }
  }

  function handleSuccess(stamp: PostageStamp) {
    if (!currentIdentityId) return

    // Set as default stamp for the identity
    identitiesStore.setDefaultStamp(currentIdentityId, stamp.batchID)

    navigateToConnectOrHome()
  }
</script>

<CreationLayout
  title="Add postage stamp (for identity)"
  onClose={handleClose}
  busy={pageState === 'purchase'}
>
  {#snippet content()}
    {#if !account || !currentIdentityId}
      <Typography>No account data found. Please start from the home page.</Typography>
    {:else}
      <AddPostageStamp
        bind:this={addPostageStampRef}
        accountId={account.id.toHex()}
        onSuccess={handleSuccess}
        introText="You chose to use a separate stamp for this identity."
        variant="account-creation"
        identityName={identity?.name}
        identityValue={identity?.id}
        autoNavigateOnSuccess={!!appData}
        bind:pageState
        bind:purchaseState
        bind:isFormDisabled
      />
    {/if}
  {/snippet}

  {#snippet buttonContent()}
    {#if account && currentIdentityId && addPostageStampRef}
      <AddPostageStampButtons
        {pageState}
        {purchaseState}
        {isFormDisabled}
        stampRef={addPostageStampRef}
        variant="account-creation"
      />
    {/if}
  {/snippet}
</CreationLayout>
