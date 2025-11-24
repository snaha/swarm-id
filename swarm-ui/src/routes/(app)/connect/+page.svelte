<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import IdentityGroups from '$lib/components/identity-groups.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { deriveIdentityKey, deriveSecret } from '$lib/utils/key-derivation'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import type { Identity } from '$lib/types'

	let appOrigin = $state('')
	let appName = $state('')
	let selectedIdentity = $state<Identity | undefined>(undefined)
	let error = $state<string | undefined>(undefined)
	let authenticated = $state(false)
	let showCreateMode = $state(false)

	const identities = $derived(identitiesStore.identities)
	const hasIdentities = $derived(identities.length > 0)

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

		// Get app origin from URL parameter
		const origin = $page.url.searchParams.get('origin')
		if (!origin) {
			error = 'No origin parameter found in URL'
			return
		}

		appOrigin = origin

		// Extract app name from origin (simple extraction from domain)
		try {
			const url = new URL(origin)
			appName = url.hostname.split('.')[0] || url.hostname
		} catch {
			appName = origin
		}
	})

	function handleIdentityClick(identity: Identity) {
		selectedIdentity = identity
		handleAuthenticate()
	}

	function handleCreateNew() {
		showCreateMode = true
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

	async function handleAuthenticate() {
		if (!selectedIdentity) {
			error = 'No identity selected. Please select an identity first.'
			return
		}

		const account = accountsStore.getAccount(selectedIdentity.accountId)
		if (!account || !account.masterKey) {
			error = 'No master key available for selected identity.'
			return
		}

		if (!appOrigin) {
			error = 'Unknown app origin. Cannot authenticate.'
			return
		}

		try {
			// Hierarchical key derivation: Account → Identity → App
			// Step 1: Derive identity-specific master key
			const identityMasterKey = await deriveIdentityKey(account.masterKey, selectedIdentity.id)

			// Step 2: Derive app-specific secret from identity master key
			const appSecret = await deriveSecret(identityMasterKey, appOrigin)

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
			})

			authenticated = true

			// Close popup after a short delay
			setTimeout(() => {
				window.close()
			}, 1500)
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
{:else if authenticated}
	<Vertical --vertical-gap="var(--padding)">
		<Typography variant="h3">Authentication Successful</Typography>
		<Typography>This window will close automatically...</Typography>
	</Vertical>
{:else}
	<ConnectedAppHeader {appName} appUrl={appOrigin} />

	{#if hasIdentities && !showCreateMode}
		<!-- Show identity list -->
		<Vertical --vertical-gap="var(--double-padding)">
			<IdentityGroups {identities} appUrl={appOrigin} onIdentityClick={handleIdentityClick} />
			<Horizontal --horizontal-justify-content="flex-start">
				<Button variant="ghost" dimension="compact" onclick={handleCreateNew}
					>Connect another account</Button
				>
			</Horizontal>
		</Vertical>
	{:else}
		<!-- No identities, show create form -->
		<CreateNewIdentity />
	{/if}
{/if}
