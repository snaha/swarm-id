<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import PostageStampForm from '$lib/components/postage-stamp-form.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { BatchId, PrivateKey } from '@ethersphere/bee-js'

  const account = $derived(sessionStore.data.account)

  let batchID = $state('')
  let depth = $state(20)
  let signerKey = $state('')
  let amount = $state(0)
  let blockNumber = $state(0)
  let submitError = $state<string | undefined>(undefined)
  let isFormDisabled = $state(true)

  function handleSkip() {
    navigateToConnectOrHome()
  }

  function handleConfirm() {
    submitError = undefined

    if (!account) return

    try {
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

      // Set as default stamp for the account
      accountsStore.setDefaultStamp(account.id, stamp.batchID)

      // If user chose separate stamps, go to identity stamp page next
      if (sessionStore.data.selectedStampOption === 'separate') {
        goto(resolve(routes.STAMPS_IDENTITY_NEW))
        return
      }

      navigateToConnectOrHome()
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Failed to add postage stamp'
    }
  }
</script>

<CreationLayout title="Add postage stamp" onClose={navigateToConnectOrHome}>
  {#snippet content()}
    {#if !account}
      <Typography>No account data found. Please start from the home page.</Typography>
    {:else}
      <Vertical --vertical-gap="var(--half-padding)">
        <Typography
          >Synced accounts require a Swarm postage stamp. Paste your stamp details below to
          continue.</Typography
        >
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
  {/snippet}

  {#snippet buttonContent()}
    {#if account}
      <Button
        variant="strong"
        dimension="compact"
        onclick={handleConfirm}
        disabled={isFormDisabled}
      >
        <Checkmark size={20} />Confirm
      </Button>
      <Typography variant="small"
        >Not ready? <button class="skip-link" onclick={handleSkip}>Skip this step</button> and create
        a local account instead (limited to viewing only).</Typography
      >
    {/if}
  {/snippet}
</CreationLayout>

<style>
  .skip-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--colors-ultra-high);
    text-decoration: underline;
    cursor: pointer;
  }

  .skip-link:hover {
    color: var(--colors-top);
  }
</style>
