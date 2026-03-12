<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import PostageStampForm from '$lib/components/postage-stamp-form.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/stores'
  import routes from '$lib/routes'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { BatchId, PrivateKey } from '@ethersphere/bee-js'
  import { accountsStore } from '$lib/stores/accounts.svelte'

  const identityId = $derived($page.params.id)
  const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
  const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)

  let batchID = $state('')
  let depth = $state(20)
  let signerKey = $state('')
  let amount = $state(0)
  let blockNumber = $state(0)
  let submitError = $state<string | undefined>(undefined)
  let isFormDisabled = $state(true)

  function handleAddStamp() {
    // Clear previous error
    submitError = undefined

    if (!identity) return
    if (!account) return

    try {
      // Create the postage stamp with defaults
      const stamp = postageStampsStore.addStamp({
        accountId: account.id.toHex(),
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

      // If this account already has a default stamp, set this as the identity's default; otherwise make it the account's default
      if (account.defaultPostageStampBatchID) {
        identitiesStore.setDefaultStamp(identity.id, stamp.batchID)
      } else {
        accountsStore.setDefaultStamp(account.id, stamp.batchID)
      }

      // Navigate back to stamps page
      goto(resolve(routes.IDENTITY_STAMPS, { id: identity.id }))
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Failed to add postage stamp'
    }
  }
</script>

<CreationLayout title="Add postage stamp" onClose={() => history.back()}>
  {#snippet content()}
    <PostageStampForm
      bind:batchID
      bind:depth
      bind:amount
      bind:blockNumber
      bind:signerKey
      bind:disabled={isFormDisabled}
      {submitError}
    />
  {/snippet}

  {#snippet buttonContent()}
    <Button dimension="compact" onclick={handleAddStamp} disabled={isFormDisabled}>
      Add postage stamp
    </Button>
  {/snippet}
</CreationLayout>
