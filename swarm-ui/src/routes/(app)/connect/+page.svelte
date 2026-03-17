<script lang="ts">
  import { onMount } from 'svelte'
  import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
  import CreateNewAccount from '$lib/components/create-new-account.svelte'
  import CreateIdentityButton from '$lib/components/create-identity-button.svelte'
  import IdentityGroups from '$lib/components/identity-groups.svelte'
  import AccountSelector from '$lib/components/account-selector.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import { deriveIdentityKey, deriveSecret } from '@swarm-id/lib'
  import { identitiesStore } from '$lib/stores/identities.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { EthAddress } from '@ethersphere/bee-js'
  import { DEFAULT_SESSION_DURATION } from '@swarm-id/lib'
  import { AppDataSchema } from '$lib/types'
  import type { Account, Identity } from '$lib/types'
  import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { ArrowRight } from 'carbon-icons-svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import {
    getMasterKeyFromAccount,
    SeedPhraseRequiredError,
    getMasterKeyFromAgentAccount,
  } from '$lib/utils/account-auth'
  import Confirmation from '$lib/components/confirmation.svelte'
  import EnterSeedModal from '$lib/components/enter-seed-modal.svelte'

  let selectedIdentity = $state<Identity | undefined>(undefined)
  let error = $state<string | undefined>(undefined)
  let authenticated = $state(false)
  let selectedAccountId = $state<EthAddress | undefined>(undefined)
  const selectedAccount = $derived(
    selectedAccountId ? accountsStore.getAccount(selectedAccountId) : undefined,
  )
  let isAuthenticating = $state(false)
  let showSeedModal = $state(false)
  let pendingAgentAccount = $state<Account | undefined>(undefined)
  let showAgentSignup = $state(false)

  const allIdentities = $derived(identitiesStore.identities)
  const identities = $derived.by(() => {
    const accountId = selectedAccountId
    if (!accountId) return allIdentities
    return allIdentities.filter((identity) => identity.accountId.equals(accountId))
  })
  const hasAccounts = $derived(accountsStore.accounts.length > 0)
  const origin = window.location.origin

  // Parse hash params (e.g., #origin=foo&appName=bar)
  function getHashParams(): URLSearchParams {
    const hash = window.location.hash.slice(1) // Remove the leading '#'
    return new URLSearchParams(hash)
  }

  onMount(() => {
    // Get parameters from URL hash (e.g., #origin=foo&appName=bar)
    const hashParams = getHashParams()
    showAgentSignup = hashParams.has('agent')

    if (!sessionStore.data.appOrigin) {
      const appOrigin = hashParams.get('origin')
      if (!appOrigin) {
        error = 'No origin parameter found in URL'
        return
      }

      sessionStore.setAppOrigin(appOrigin)
      if (!sessionStore.data.appOrigin) {
        return
      }
    }

    if (!sessionStore.data.appData) {
      // Get app metadata from URL hash parameters (if provided)
      const hashParams = getHashParams()
      const urlAppName = hashParams.get('appName')
      const urlAppDescription = hashParams.get('appDescription')
      const urlAppIcon = hashParams.get('appIcon')

      const appData = {
        appUrl: sessionStore.data.appOrigin,
        appName: tryGetAppName(urlAppName),
        appDescription: urlAppDescription ?? undefined,
        appIcon: urlAppIcon ?? undefined,
      }

      // Validate app data from URL parameters
      const validationResult = AppDataSchema.safeParse(appData)
      if (!validationResult.success) {
        error = `Invalid app data: ${validationResult.error.issues.map((i) => i.message).join(', ')}`
        return
      }

      sessionStore.setAppData(validationResult.data)
    }

    // If there is a new identity set it up
    if (sessionStore.data.currentIdentityId) {
      const identity = identitiesStore.getIdentity(sessionStore.data.currentIdentityId)
      if (identity) {
        selectIdentityForConnection(identity)
      }
    }
  })

  function tryGetAppName(urlAppName: string | null) {
    if (urlAppName) {
      return urlAppName
    }

    // Fallback: Extract app name from origin
    try {
      const url = new URL(origin)
      return url.hostname.split('.')[0] || url.hostname
    } catch {
      return origin
    }
  }

  async function selectIdentityForConnection(identity: Identity) {
    error = undefined
    selectedIdentity = identity

    // Check if there's a valid existing connection
    if (sessionStore.data.appOrigin) {
      const validConnection = connectedAppsStore.getValidConnection(
        sessionStore.data.appOrigin,
        identity.id,
      )
      if (validConnection?.appSecret) {
        // Reuse the existing connection
        updateSelectedIdentity(validConnection.appSecret)
        authenticated = true
        closeWindowWithSessionCleanup()
        return
      }
    }

    await handleAuthenticate()

    // If this was an existing identity (not from creation flow), close automatically
    // But don't close if we're waiting for seed phrase input (agent accounts)
    if (!error && !sessionStore.data.currentIdentityId && !showSeedModal) {
      closeWindowWithSessionCleanup()
    }
  }

  function updateSelectedIdentity(appSecret: string) {
    if (!selectedIdentity) {
      return
    }

    if (!sessionStore.data.appOrigin) {
      return
    }

    if (!sessionStore.data.appData) {
      return
    }

    // Write to localStorage - this triggers storage events in the iframe
    // which will detect the new connection and authenticate
    connectedAppsStore.addOrUpdateApp(
      {
        appUrl: sessionStore.data.appOrigin,
        appName: sessionStore.data.appData.appName,
        identityId: selectedIdentity.id,
        appIcon: sessionStore.data.appData.appIcon,
        appDescription: sessionStore.data.appData.appDescription,
        appSecret,
      },
      DEFAULT_SESSION_DURATION,
    )
  }

  async function tryGetMasterKeyFromAccount(account: Account) {
    if (sessionStore.data.temporaryMasterKey) {
      const masterKey = sessionStore.data.temporaryMasterKey
      sessionStore.clearTemporaryMasterKey()
      return masterKey
    }

    try {
      isAuthenticating = true
      return await getMasterKeyFromAccount(account)
    } catch (err) {
      if (err instanceof SeedPhraseRequiredError) {
        // Agent accounts need seed phrase - show modal
        pendingAgentAccount = account
        showSeedModal = true
        isAuthenticating = false
        return undefined
      }
      throw err
    } finally {
      if (!showSeedModal) {
        isAuthenticating = false
      }
    }
  }

  async function handleSeedPhraseProvided(seedPhrase: string) {
    if (!pendingAgentAccount) return

    try {
      const masterKey = getMasterKeyFromAgentAccount(pendingAgentAccount, seedPhrase)
      sessionStore.setTemporaryMasterKey(masterKey)
      pendingAgentAccount = undefined

      // Re-trigger the authentication flow
      if (selectedIdentity) {
        await handleAuthenticate()
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Invalid seed phrase'
      pendingAgentAccount = undefined
    }
  }

  function handleSeedModalCancel() {
    pendingAgentAccount = undefined
    isAuthenticating = false
  }

  async function handleAuthenticate() {
    if (!selectedIdentity) {
      error = 'No identity selected. Please select an identity first.'
      return
    }

    const account = accountsStore.getAccount(selectedIdentity.accountId)
    if (!account) {
      error = 'Account not found for selected identity.'
      return
    }

    if (!sessionStore.data.appOrigin) {
      error = 'Unknown app origin. Cannot authenticate.'
      return
    }

    try {
      // Retrieve masterKey based on account type
      const masterKey = await tryGetMasterKeyFromAccount(account)

      // If masterKey is undefined, we're waiting for seed phrase input
      if (!masterKey) {
        return
      }

      // Hierarchical key derivation: Account → Identity → App
      // Step 1: Derive identity-specific master key
      const identityMasterKey = await deriveIdentityKey(masterKey.toHex(), selectedIdentity.id)

      // Step 2: Derive app-specific secret from identity master key
      const appSecret = await deriveSecret(identityMasterKey, sessionStore.data.appOrigin)

      updateSelectedIdentity(appSecret)

      authenticated = true
    } catch (err) {
      error = err instanceof Error ? err.message : 'Authentication failed'
    }
  }

  function closeWindowWithSessionCleanup() {
    sessionStore.clear()
    window.close()
  }
</script>

{#if error}
  <Vertical --vertical-gap="var(--padding)">
    <Typography variant="h3">Error</Typography>
    <Typography>{error}</Typography>
  </Vertical>
{:else if isAuthenticating && selectedAccount}
  <Confirmation authenticationType={selectedAccount.type} />
{:else if selectedIdentity && authenticated}
  <Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
    <Vertical --vertical-gap="var(--half-padding)">
      <Polycon value={selectedIdentity.id} size={80} />
      <Typography>{selectedIdentity.name}</Typography>
    </Vertical>
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography variant="large">✅ All set!</Typography>
      <Typography>Your identity is ready to use.</Typography>
    </Vertical>
    <Button variant="strong" dimension="compact" onclick={closeWindowWithSessionCleanup}
      >Continue to app<ArrowRight size={20} /></Button
    >
    <!-- eslint-disable svelte/no-navigation-without-resolve -- full URL, not a route -->
    <Typography variant="small"
      >Manage your account and create more identities at <a href={origin}>id.ethswarm.org</a
      ></Typography
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </Vertical>
{:else if sessionStore.data.appOrigin && sessionStore.data.appData}
  {#snippet connectedAppHeader()}
    <ConnectedAppHeader
      appName={sessionStore.data.appData?.appName ?? ''}
      appUrl={sessionStore.data.appOrigin ?? ''}
      appIcon={sessionStore.data.appData?.appIcon}
      appDescription={sessionStore.data.appData?.appDescription}
    />
  {/snippet}

  {#if hasAccounts}
    {@render connectedAppHeader()}
    <!-- Show identity list -->
    <Vertical --vertical-gap="var(--double-padding)">
      <AccountSelector bind:selectedAccount={selectedAccountId} />
      <IdentityGroups
        {identities}
        appUrl={sessionStore.data.appOrigin}
        onIdentityClick={selectIdentityForConnection}
      />
      <Horizontal --horizontal-justify-content="flex-start">
        <CreateIdentityButton account={selectedAccount} bind:isAuthenticating />
      </Horizontal>
    </Vertical>
  {:else}
    <!-- No accounts, show create form -->
    <CreateNewAccount header={connectedAppHeader} {showAgentSignup} />
  {/if}
{/if}

<EnterSeedModal
  bind:open={showSeedModal}
  onUnlock={handleSeedPhraseProvided}
  onCancel={handleSeedModalCancel}
/>
