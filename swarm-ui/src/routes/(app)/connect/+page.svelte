<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import routes from '$lib/routes'
	import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import IdentityGroups from '$lib/components/identity-groups.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import { deriveIdentityKey, deriveSecret } from '$lib/utils/key-derivation'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { keccak256 } from 'ethers'
	import { hexToUint8Array } from '$lib/utils/key-derivation'
	import type { Identity, Account } from '$lib/types'
	import { connectAndSign } from '$lib/ethereum'
	import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
	import Hashicon from '$lib/components/hashicon.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import Add from 'carbon-icons-svelte/lib/Add.svelte'
	import { ArrowRight } from 'carbon-icons-svelte'
	import { sessionStore } from '$lib/stores/session.svelte'

	let appOrigin = $state('')
	let appName = $state('')
	let appDescription = $state<string | undefined>(undefined)
	let appIcon = $state<string | undefined>(undefined)
	let selectedIdentity = $state<Identity | undefined>(undefined)
	let error = $state<string | undefined>(undefined)
	let showCreateMode = $state(false)
	let authenticated = $state(false)
	let selectedAccountId = $state<string | undefined>(undefined)

	const accounts = $derived(accountsStore.accounts)
	const accountItems = $derived(
		accounts.map((account) => ({
			value: account.id,
			label: account.name,
			icon: account.type === 'passkey' ? PasskeyLogo : EthereumLogo,
		})),
	)

	// Initialize from session store or default to first account
	$effect(() => {
		if (!selectedAccountId) {
			if (sessionStore.data.account?.id) {
				selectedAccountId = sessionStore.data.account.id
			} else if (accounts.length > 0) {
				selectedAccountId = accounts[0].id
				sessionStore.setAccount(accounts[0])
			}
		}
	})

	// Sync selection changes to session store
	$effect(() => {
		if (selectedAccountId && selectedAccountId !== sessionStore.data.account?.id) {
			const account = accountsStore.getAccount(selectedAccountId)
			if (account) {
				sessionStore.setAccount(account)
			}
		}
	})

	const allIdentities = $derived(identitiesStore.identities)
	const identities = $derived(
		selectedAccountId
			? allIdentities.filter((identity) => identity.accountId === selectedAccountId)
			: allIdentities,
	)
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

		// Get parameters from URL
		const origin = $page.url.searchParams.get('origin')
		if (!origin) {
			error = 'No origin parameter found in URL'
			return
		}

		appOrigin = origin

		// Get app metadata from URL parameters (if provided)
		const urlAppName = $page.url.searchParams.get('appName')
		const urlAppDescription = $page.url.searchParams.get('appDescription')
		const urlAppIcon = $page.url.searchParams.get('appIcon')

		// Use metadata from URL if available, otherwise derive from origin
		if (urlAppName) {
			appName = urlAppName
			appDescription = urlAppDescription ?? undefined
			appIcon = urlAppIcon ?? undefined
		} else {
			// Fallback: Extract app name from origin
			try {
				const url = new URL(origin)
				appName = url.hostname.split('.')[0] || url.hostname
			} catch {
				appName = origin
			}
		}

		// If there is a new identity set it up
		if (sessionStore.data.currentIdentityId) {
			const identity = identitiesStore.getIdentity(sessionStore.data.currentIdentityId)
			if (identity) {
				selectIdentityForConnection(identity)
			}
		}
	})

	function selectIdentityForConnection(identity: Identity) {
		selectedIdentity = identity
		handleAuthenticate()
	}

	function handleCreateNew() {
		showCreateMode = true
	}

	async function handleCreateNewIdentity() {
		if (!selectedAccountId) return
		const account = accountsStore.getAccount(selectedAccountId)
		if (!account) return

		try {
			const masterKey = await getMasterKeyFromAccount(account)
			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(masterKey)
			const url = appOrigin
				? `${routes.IDENTITY_NEW}?origin=${encodeURIComponent(appOrigin)}`
				: routes.IDENTITY_NEW
			goto(url)
		} catch (err) {
			console.error('Failed to authenticate:', err)
		}
	}

	// FIXME: Temporary function to generate random postage batch ID for testing
	// In production, this should come from the identity's actual postage stamps
	function generateRandomPostageBatchId(): string {
		const bytes = new Uint8Array(32) // 32 bytes = 64 hex chars
		crypto.getRandomValues(bytes)
		return Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
	}

	/**
	 * Retrieve masterKey from account based on account type
	 */
	async function getMasterKeyFromAccount(account: Account): Promise<string> {
		if (account.type === 'passkey') {
			// For passkey accounts: Re-authenticate to get masterKey
			console.log('🔐 Re-authenticating with passkey...')
			const swarmIdDomain = window.location.hostname
			const challenge = hexToUint8Array(keccak256(new TextEncoder().encode(swarmIdDomain)))

			// Use allowCredentials to guide WebAuthn to the correct passkey
			const passkeyAccount = await authenticateWithPasskey({
				rpId: swarmIdDomain,
				challenge,
				allowCredentials: [{ id: account.credentialId, type: 'public-key' }],
			})

			console.log('✅ Passkey authentication successful')
			return passkeyAccount.masterKey
		} else {
			// Connect wallet and sign SIWE message
			const signed = await connectAndSign()

			// Derive encryption key from public key + salt
			const encryptionKey = await deriveEncryptionKey(signed.publicKey, account.encryptionSalt)
			console.log('🔑 Encryption key derived')

			const masterKey = await decryptMasterKey(account.encryptedMasterKey, encryptionKey)
			console.log('✅ Ethereum authentication successful')

			return masterKey
		}
	}

	function updateSelectedIdentity(appSecret: string) {
		if (!selectedIdentity) {
			return
		}

		// FIXME: Generate random postage batch ID for testing
		// In production, use the identity's default postage stamp or let user choose
		const postageBatchId = generateRandomPostageBatchId()

		// Send secret to opener (the iframe that opened this popup)
		if (!window.opener || (window.opener as Window).closed) {
			error = 'Opener window not available'
			return
		}

		;(window.opener as Window).postMessage(
			{
				type: 'setSecret',
				appOrigin: appOrigin,
				data: {
					secret: appSecret,
					postageBatchId, // FIXME: Should come from identity's actual stamps
				},
			},
			window.location.origin,
		)

		// Track this app connection
		connectedAppsStore.addOrUpdateApp({
			appUrl: appOrigin,
			appName: appName,
			identityId: selectedIdentity.id,
			appIcon: appIcon,
			appDescription: appDescription,
		})
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

		if (!appOrigin) {
			error = 'Unknown app origin. Cannot authenticate.'
			return
		}

		try {
			// Retrieve masterKey based on account type
			const masterKey =
				sessionStore.data.temporaryMasterKey ?? (await getMasterKeyFromAccount(account))

			sessionStore.clearTemporaryMasterKey()

			authenticated = true

			// Hierarchical key derivation: Account → Identity → App
			// Step 1: Derive identity-specific master key
			const identityMasterKey = await deriveIdentityKey(masterKey, selectedIdentity.id)

			// Step 2: Derive app-specific secret from identity master key
			const appSecret = await deriveSecret(identityMasterKey, appOrigin)

			updateSelectedIdentity(appSecret)
		} catch (err) {
			error = err instanceof Error ? err.message : 'Authentication failed'
		}
	}
</script>

{#if error}
	<Vertical --vertical-gap="var(--padding)">
		<Typography variant="h3">Error</Typography>
		<Typography>{error}</Typography>
	</Vertical>
{:else if selectedIdentity}
	<Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
		<Vertical --vertical-gap="var(--half-padding)">
			<Hashicon value={selectedIdentity.id} size={80} />
			<Typography>{selectedIdentity.name}</Typography>
		</Vertical>
		{#if authenticated}
			<Vertical --vertical-gap="var(--half-padding)">
				<Typography variant="large">✅ All set!</Typography>
				<Typography>Your identity is ready to use.</Typography>
			</Vertical>
			<Button variant="strong" dimension="compact" onclick={() => window.close()}
				>Continue to app<ArrowRight size={20} /></Button
			>
			<Typography variant="small"
				>Manage your account and create more identities at <a href={origin}>id.ethswarm.org</a
				></Typography
			>
		{/if}
	</Vertical>
{:else}
	<ConnectedAppHeader {appName} appUrl={appOrigin} {appIcon} {appDescription} />

	{#if hasIdentities && !showCreateMode}
		<!-- Show identity list -->
		<Vertical --vertical-gap="var(--double-padding)">
			<Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
				<Typography>Account</Typography>
				<Select
					items={accountItems}
					bind:value={selectedAccountId}
					dimension="compact"
					variant="solid"
					actionLabel="Add account..."
					actionIcon={Add}
					onaction={handleCreateNew}
				/>
			</Horizontal>
			<IdentityGroups
				{identities}
				appUrl={appOrigin}
				onIdentityClick={selectIdentityForConnection}
			/>
			<Horizontal --horizontal-justify-content="flex-start">
				<Button variant="ghost" dimension="compact" onclick={handleCreateNewIdentity}>
					<Add size={20} />Create new identity
				</Button>
			</Horizontal>
		</Vertical>
	{:else}
		<!-- No identities, show create form -->
		<CreateNewIdentity />
	{/if}
{/if}
