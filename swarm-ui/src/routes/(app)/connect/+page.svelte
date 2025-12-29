<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/state'
	import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
	import CreateNewAccount from '$lib/components/create-new-account.svelte'
	import CreateIdentityButton from '$lib/components/create-identity-button.svelte'
	import IdentityGroups from '$lib/components/identity-groups.svelte'
	import AccountSelector from '$lib/components/account-selector.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { deriveIdentityKey, deriveSecret } from '$lib/utils/key-derivation'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { EthAddress } from '@ethersphere/bee-js'
	import { AppDataSchema, DEFAULT_SESSION_DURATION } from '$lib/types'
	import type { Account, Identity } from '$lib/types'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import { ArrowRight } from 'carbon-icons-svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { getMasterKeyFromAccount } from '$lib/utils/account-auth'
	import Confirmation from '$lib/components/confirmation.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import type { SetSecretMessage } from '@swarm-id/lib'

	let selectedIdentity = $state<Identity | undefined>(undefined)
	let error = $state<string | undefined>(undefined)
	let showCreateMode = $state(false)
	let authenticated = $state(false)
	let selectedAccountId = $state<EthAddress | undefined>(undefined)
	const selectedAccount = $derived(
		selectedAccountId ? accountsStore.getAccount(selectedAccountId) : undefined,
	)
	let isAuthenticating = $state(false)

	const allIdentities = $derived(identitiesStore.identities)
	const identities = $derived.by(() => {
		const accountId = selectedAccountId
		if (!accountId) return allIdentities
		return allIdentities.filter((identity) => identity.accountId.equals(accountId))
	})
	const hasIdentities = $derived(identities.length > 0)
	const origin = window.location.origin

	onMount(() => {
		// Validate opener window
		if (!window.opener) {
			error = 'No opener window found. This page must be opened by Swarm ID iframe.'
			return
		}

		// Check opener origin
		try {
			const openerOrigin = (window.opener as Window).location.origin
			if (openerOrigin !== window.location.origin) {
				error = `Opener origin (${openerOrigin}) does not match expected origin`
				return
			}
		} catch {
			error = 'Cannot verify opener origin - cross-origin access denied'
			return
		}

		if (!sessionStore.data.appOrigin) {
			// Get parameters from URL
			const appOrigin = page.url.searchParams.get('origin')
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
			// Get app metadata from URL parameters (if provided)
			const urlAppName = page.url.searchParams.get('appName')
			const urlAppDescription = page.url.searchParams.get('appDescription')
			const urlAppIcon = page.url.searchParams.get('appIcon')

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
		selectedIdentity = identity
		await handleAuthenticate()

		// If this was an existing identity then close the window automatically
		if (!error && !sessionStore.data.currentIdentityId) {
			closeWindowWithSessionCleanup()
		}
	}

	function handleCreateNew() {
		showCreateMode = true
	}

	function getIdentityPostageBatchId(identity: Identity): string | undefined {
		const postageStamp = postageStampsStore.stamps.find(stamp => stamp.identityId === identity.id)
		if (!postageStamp) {
			return
		}
		return postageStamp.batchID.toHex()
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

		// FIXME: Generate random postage batch ID for testing
		// In production, use the identity's default postage stamp or let user choose
		const postageBatchId = getIdentityPostageBatchId(selectedIdentity)

		// Send secret to opener (the iframe that opened this popup)
		if (!window.opener || (window.opener as Window).closed) {
			error = 'Opener window not available'
			return
		}

		const message: SetSecretMessage = {
			type: 'setSecret',
			appOrigin: sessionStore.data.appOrigin,
			data: {
				secret: appSecret,
				postageBatchId,
			},
		}

		;(window.opener as Window).postMessage(message, window.location.origin)

		// Track this app connection
		connectedAppsStore.addOrUpdateApp(
			{
				appUrl: sessionStore.data.appOrigin,
				appName: sessionStore.data.appData.appName,
				identityId: selectedIdentity.id,
				appIcon: sessionStore.data.appData.appIcon,
				appDescription: sessionStore.data.appData.appDescription,
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
		} finally {
			isAuthenticating = false
		}
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

			// Hierarchical key derivation: Account → Identity → App
			// Step 1: Derive identity-specific master key
			const identityMasterKey = await deriveIdentityKey(masterKey, selectedIdentity.id)

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
			<Hashicon value={selectedIdentity.id} size={80} />
			<Typography>{selectedIdentity.name}</Typography>
		</Vertical>
		<Vertical --vertical-gap="var(--half-padding)">
			<Typography variant="large">✅ All set!</Typography>
			<Typography>Your identity is ready to use.</Typography>
		</Vertical>
		<Button variant="strong" dimension="compact" onclick={closeWindowWithSessionCleanup}
			>Continue to app<ArrowRight size={20} /></Button
		>
		<Typography variant="small"
			>Manage your account and create more identities at <a href={origin}>id.ethswarm.org</a
			></Typography
		>
	</Vertical>
{:else if sessionStore.data.appOrigin && sessionStore.data.appData}
	<ConnectedAppHeader
		appName={sessionStore.data.appData.appName}
		appUrl={sessionStore.data.appOrigin}
		appIcon={sessionStore.data.appData.appIcon}
		appDescription={sessionStore.data.appData.appDescription}
	/>

	{#if hasIdentities && !showCreateMode}
		<!-- Show identity list -->
		<Vertical --vertical-gap="var(--double-padding)">
			<AccountSelector bind:selectedAccount={selectedAccountId} onCreateAccount={handleCreateNew} />
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
		<!-- No identities, show create form -->
		<CreateNewAccount />
	{/if}
{/if}
