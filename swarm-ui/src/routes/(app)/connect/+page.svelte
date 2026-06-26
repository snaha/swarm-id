<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
  import CreateNewAccount from '$lib/components/create-new-account.svelte'
  import CreateAccountButton from '$lib/components/create-account-button.svelte'
  import AccountList from '$lib/components/account-list.svelte'
  import SegmentedTabs from '$lib/components/segmented-tabs.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import { deriveSecret, STORAGE_CHALLENGE_KEY } from '@snaha/swarm-id'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { DEFAULT_SESSION_DURATION } from '@snaha/swarm-id'
  import { AppDataSchema } from '$lib/types'
  import type { Account } from '$lib/types'
  import { layoutStore } from '$lib/stores/layout.svelte'
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

  // The account the user picked to connect this app to.
  let selected = $state<Account | undefined>(undefined)
  let error = $state<string | undefined>(undefined)
  let authenticated = $state(false)
  let isAuthenticating = $state(false)
  let showSeedModal = $state(false)
  let pendingAgentAccount = $state<Account | undefined>(undefined)
  let showAgentSignup = $state(false)
  let storagePartitioned = $state(false)
  let storageChallenge = $state<string | undefined>(undefined)
  let lastAppSecret = $state<string | undefined>(undefined)

  const accounts = $derived(accountsStore.accounts)
  const hasAccounts = $derived(accounts.length > 0)
  const origin = window.location.origin

  // Accounts previously used to connect to this app, most-recently-used first.
  const previouslyUsedAccounts = $derived.by(() => {
    const appUrl = sessionStore.data.appOrigin
    if (!appUrl) return []
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral dedupe set
    const seen = new Set<string>()
    const ordered: Account[] = []
    for (const { account, app } of accountsStore.getRecentConnections()) {
      const key = account.id.toHex()
      if (app.appUrl !== appUrl || seen.has(key)) continue
      seen.add(key)
      ordered.push(account)
    }
    return ordered
  })

  const hasPreviouslyUsed = $derived(previouslyUsedAccounts.length > 0)

  type ConnectTab = 'previously-used' | 'all-accounts'
  const TABS: readonly { value: ConnectTab; label: string }[] = [
    { value: 'previously-used', label: 'Previously used' },
    { value: 'all-accounts', label: 'All accounts' },
  ]

  // Defaults to "Previously used" when available, but a user selection takes precedence.
  let selectedTab = $state<ConnectTab | undefined>(undefined)
  const activeTab = $derived(
    selectedTab ?? (hasPreviouslyUsed ? 'previously-used' : 'all-accounts'),
  )

  // Parse hash params (e.g., #origin=foo&appName=bar)
  function getHashParams(): URLSearchParams {
    const hash = window.location.hash.slice(1) // Remove the leading '#'
    return new URLSearchParams(hash)
  }

  onMount(() => {
    // Get parameters from URL hash (e.g., #origin=foo&appName=bar)
    const hashParams = getHashParams()
    showAgentSignup = hashParams.has('agent')

    // Storage partitioning detection: proxy opens this popup with a challenge,
    // check if we can read it from localStorage (shared storage)
    const challenge = hashParams.get('challenge')
    if (challenge) {
      const storedChallenge = localStorage.getItem(STORAGE_CHALLENGE_KEY)
      if (storedChallenge === challenge) {
        // Storage is shared — normal mode, clean up challenge
        localStorage.removeItem(STORAGE_CHALLENGE_KEY)
      } else {
        // Storage is partitioned — use postMessage fallback
        storagePartitioned = true
        storageChallenge = challenge
        // Persist so it survives in-popup navigation (e.g. account creation flow)
        sessionStore.setStoragePartitioned(challenge)
      }
    } else if (sessionStore.data.storagePartitioned && sessionStore.data.storageChallenge) {
      // Restore partitioning state after in-popup navigation
      storagePartitioned = true
      storageChallenge = sessionStore.data.storageChallenge
    }

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

  async function selectAccountForConnection(account: Account) {
    error = undefined
    selected = account

    // Check if there's a valid existing connection
    if (sessionStore.data.appOrigin) {
      const validConnection = accountsStore.getValidConnection(
        account.id,
        sessionStore.data.appOrigin,
      )
      if (validConnection?.appSecret) {
        // Reuse the existing connection
        updateSelected(validConnection.appSecret)
        authenticated = true
        closeWindowWithSessionCleanup()
        return
      }
    }

    await handleAuthenticate()

    // Close automatically once authenticated, unless we're waiting for a seed
    // phrase (agent accounts).
    if (!error && !showSeedModal) {
      closeWindowWithSessionCleanup()
    }
  }

  function updateSelected(appSecret: string) {
    if (!selected || !sessionStore.data.appOrigin || !sessionStore.data.appData) {
      return
    }

    // Store for potential storage partitioning postMessage fallback
    lastAppSecret = appSecret

    // Write to the account's nested apps — this triggers a storage event in the
    // iframe which detects the new connection and authenticates.
    accountsStore.addOrUpdateApp(
      selected.id,
      {
        appUrl: sessionStore.data.appOrigin,
        appName: sessionStore.data.appData.appName,
        appIcon: sessionStore.data.appData.appIcon,
        appDescription: sessionStore.data.appData.appDescription,
        appSecret,
      },
      DEFAULT_SESSION_DURATION,
    )
  }

  /**
   * Send app secret to the iframe via postMessage (storage partitioning fallback).
   * The `identity*` fields carry the ACCOUNT's info (single-level model).
   */
  function sendSecretToOpener(appSecret: string) {
    if (!window.opener) {
      console.warn('[Connect] No window.opener available for postMessage')
      return
    }

    if (!sessionStore.data.appOrigin || !selected || !storageChallenge) {
      return
    }

    window.opener.postMessage(
      {
        type: 'setSecret',
        appOrigin: sessionStore.data.appOrigin,
        challenge: storageChallenge,
        data: {
          secret: appSecret,
          identityId: selected.id.toHex(),
          identityName: selected.name,
          identityAddress: selected.id.toHex(),
          identityPublicKey: selected.publicKey,
        },
      },
      window.location.origin,
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
      if (selected) {
        await handleAuthenticate()
        if (!error && !showSeedModal) {
          closeWindowWithSessionCleanup()
        }
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
    if (!selected) {
      error = 'No account selected. Please select an account first.'
      return
    }

    if (!sessionStore.data.appOrigin) {
      error = 'Unknown app origin. Cannot authenticate.'
      return
    }

    try {
      // Retrieve masterKey based on account type
      const masterKey = await tryGetMasterKeyFromAccount(selected)

      // If masterKey is undefined, we're waiting for seed phrase input
      if (!masterKey) {
        return
      }

      // App-specific secret derived directly from the account master key
      // (the account is the single-level app-facing identity).
      const appSecret = await deriveSecret(masterKey.toHex(), sessionStore.data.appOrigin)

      updateSelected(appSecret)

      authenticated = true
    } catch (err) {
      error = err instanceof Error ? err.message : 'Authentication failed'
    }
  }

  function closeWindowWithSessionCleanup() {
    // When storage partitioning is detected, send the secret via postMessage to the iframe
    // since storage events won't fire across partitioned storage
    if (storagePartitioned && lastAppSecret) {
      sendSecretToOpener(lastAppSecret)
    }
    sessionStore.clear()
    window.close()
  }
</script>

{#if error}
  <Vertical --vertical-gap="var(--padding)">
    <Typography variant="h3">Error</Typography>
    <Typography>{error}</Typography>
  </Vertical>
{:else if isAuthenticating && selected}
  <Confirmation
    authenticationType={selected.access?.type === 'eth-wallet'
      ? 'ethereum'
      : selected.access?.type === 'passkey'
        ? 'passkey'
        : 'agent'}
  />
{:else if selected && authenticated}
  <Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
    <Vertical --vertical-gap="var(--half-padding)">
      <Polycon value={selected.id.toHex()} size={80} />
      <Typography>{selected.name}</Typography>
    </Vertical>
    <Vertical --vertical-gap="var(--half-padding)">
      <Typography variant="large">✅ All set!</Typography>
      <Typography>Your account is ready to use.</Typography>
    </Vertical>
    <Button variant="strong" dimension="compact" onclick={closeWindowWithSessionCleanup}
      >Continue to app<ArrowRight size={20} /></Button
    >
    <!-- eslint-disable svelte/no-navigation-without-resolve -- full URL, not a route -->
    <Typography variant="small"
      >Manage your accounts at <a href={origin}>id.ethswarm.org</a></Typography
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
    <!-- Pick an account to connect -->
    <Vertical --vertical-gap="var(--double-padding)">
      {#if hasPreviouslyUsed}
        <SegmentedTabs tabs={TABS} active={activeTab} onchange={(value) => (selectedTab = value)} />
      {/if}

      {#if activeTab === 'previously-used'}
        <AccountList
          accounts={previouslyUsedAccounts}
          onAccountClick={selectAccountForConnection}
        />
      {:else}
        <AccountList {accounts} onAccountClick={selectAccountForConnection} />
        <Horizontal --horizontal-justify-content={layoutStore.mobile ? 'center' : 'flex-start'}>
          <CreateAccountButton />
        </Horizontal>
      {/if}
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
