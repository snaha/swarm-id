<script lang="ts">
  import Typography from '$lib/components/ui/typography.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
  import Information from 'carbon-icons-svelte/lib/Information.svelte'
  import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte'
  import routes from '$lib/routes'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import Hashicon from '$lib/components/hashicon.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import Tooltip from '$lib/components/ui/tooltip.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { onMount } from 'svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import type { Identity, Account } from '$lib/types'
  import { HDNodeWallet } from 'ethers'
  import { Bytes } from '@ethersphere/bee-js'
  import { toPrefixedHex } from '$lib/utils/hex'
  import { generateDockerName } from '$lib/docker-name'
  import Vertical from '$lib/components/ui/vertical.svelte'

  type StampOption = 'account' | 'separate'

  let idName = $state('')
  let selectedStampOption = $state<StampOption>('account')
  let showStampTooltip = $state(false)

  // Check if this is a synced account creation
  const isSyncedCreation = $derived(sessionStore.data.isSyncedCreation ?? false)

  // Derive identity using temporary masterKey from session
  const derivedIdentity = $derived.by(() => {
    const account = sessionStore.data.account
    const tempMasterKey = sessionStore.data.temporaryMasterKey

    if (!account || !tempMasterKey) {
      return undefined
    }

    const index = identitiesStore.identities.filter((identity) =>
      identity.accountId.equals(account.id),
    ).length

    return deriveIdentityFromAccount(account, tempMasterKey, index)
  })

  onMount(() => {
    idName = derivedIdentity?.name ?? ''
  })

  const hasSessionData = $derived(
    sessionStore.data.account !== undefined && sessionStore.data.temporaryMasterKey !== undefined,
  )

  const accountName = $derived(sessionStore.data.account?.name ?? '')

  function deriveIdentityFromAccount(account: Account, masterKey: Bytes, index: number) {
    const identityWallet = HDNodeWallet.fromSeed(toPrefixedHex(masterKey)).deriveChild(index)
    const id = identityWallet.address
    const name = generateDockerName(id)
    const accountId = account.id
    const createdAt = Date.now()
    const identity: Identity = {
      id,
      accountId,
      name,
      createdAt,
    }
    return identity
  }

  async function handleCreateIdentity() {
    const sessionAccount = sessionStore.data.account
    const tempMasterKey = sessionStore.data.temporaryMasterKey

    if (!sessionAccount || !tempMasterKey) {
      console.error('❌ No account data or masterKey in session')
      return
    }

    if (!derivedIdentity) {
      console.error('❌ No derived identity available')
      return
    }

    const account = accountsStore.getAccount(sessionAccount.id)
    if (!account) {
      console.error('❌ Account not found in store')
      return
    }

    // Create the identity with custom name (identity stamp will be set on the identity stamp page)
    const identity = identitiesStore.addIdentity({
      ...derivedIdentity,
      name: idName || derivedIdentity.name,
    })

    console.log('✅ Identity created:', identity.id)

    // Set as current account and identity
    sessionStore.setCurrentAccount(account.id.toHex())
    sessionStore.setCurrentIdentity(identity.id)

    // Store stamp option in session for downstream pages
    sessionStore.setStampOption(selectedStampOption)

    // Local accounts skip stamps entirely
    if (!isSyncedCreation) {
      navigateToConnectOrHome()
      return
    }

    // Synced account without an account stamp → go to account stamp page first
    if (!account.defaultPostageStampBatchID) {
      goto(resolve(routes.STAMPS_ACCOUNT_NEW))
      return
    }

    // Synced account with account stamp + "separate" → go to identity stamp page
    if (selectedStampOption === 'separate') {
      goto(resolve(routes.STAMPS_IDENTITY_NEW))
      return
    }

    // Synced account with account stamp + "account" option → done
    navigateToConnectOrHome()
  }
</script>

<CreationLayout
  title="Create identity"
  description={accountName ? `in ${accountName} account` : undefined}
  onClose={navigateToConnectOrHome}
>
  {#snippet content()}
    {#if !hasSessionData}
      <Typography>No account data found. Please start from the home page.</Typography>
    {:else}
      <Vertical --vertical-gap="var(--padding)">
        <!-- Identity name input -->
        <Vertical --vertical-gap="var(--quarter-padding)">
          <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="end">
            <div class="input-grow">
              <Input
                variant="outline"
                dimension="compact"
                label="Identity name"
                bind:value={idName}
              />
            </div>
            {#if derivedIdentity}
              <Hashicon value={derivedIdentity.id} size={40} />
            {/if}
          </Horizontal>
          <Typography variant="small">Displayed in your account and apps</Typography>
        </Vertical>

        <!-- Postage stamp selector (only for synced accounts) -->
        {#if isSyncedCreation}
          <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="end">
            <div class="input-grow">
              <Vertical --vertical-gap="var(--quarter-padding)">
                <Typography>Postage stamp</Typography>
                <div class="select-wrapper">
                  <select class="stamp-select" bind:value={selectedStampOption}>
                    <option value="account">Use account stamp (default)</option>
                    <option value="separate">Use separate stamp (advanced)</option>
                  </select>
                  <ChevronDown size={20} class="select-icon" />
                </div>
              </Vertical>
            </div>
            <Tooltip
              helperText="Use your account stamp for simplicity, or assign a separate stamp to keep this identity's activity separate from your other identities. You can change this later."
              position="left"
              variant="small"
              maxWidth="280px"
              show={showStampTooltip}
            >
              <Button
                variant="ghost"
                dimension="compact"
                onclick={() => (showStampTooltip = !showStampTooltip)}
              >
                <Information size={20} />
              </Button>
            </Tooltip>
          </Horizontal>
        {/if}
      </Vertical>
    {/if}
  {/snippet}

  {#snippet buttonContent()}
    {#if hasSessionData}
      <Button
        variant="strong"
        dimension="compact"
        onclick={handleCreateIdentity}
        disabled={!derivedIdentity}
      >
        <Checkmark size={20} />Confirm
      </Button>
    {/if}
  {/snippet}
</CreationLayout>

<style>
  .input-grow {
    flex: 1;
    min-width: 0;
  }

  /* Select wrapper for custom styled select */
  .select-wrapper {
    position: relative;
    width: 100%;
  }

  .stamp-select {
    width: 100%;
    padding: var(--half-padding);
    padding-right: calc(var(--half-padding) + 24px);
    border: 1px solid var(--colors-ultra-high);
    background: transparent;
    font-family: var(--font-family-sans-serif);
    font-size: var(--font-size);
    line-height: var(--line-height);
    color: var(--colors-ultra-high);
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
  }

  .stamp-select:focus {
    outline: var(--focus-outline);
    outline-offset: var(--focus-outline-offset);
  }

  .stamp-select:hover {
    border-color: var(--colors-top);
  }

  .select-wrapper :global(.select-icon) {
    position: absolute;
    right: var(--half-padding);
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--colors-ultra-high);
  }
</style>
