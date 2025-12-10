<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { getOrCreatePasskeyAccount } from '$lib/passkey'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import FolderShared from 'carbon-icons-svelte/lib/FolderShared.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { keccak256 } from 'ethers'
	import { hexToUint8Array } from '$lib/utils/key-derivation'
	import { accountsStore } from '$lib/stores/accounts.svelte'

	let accountName = $state('Passkey')
	let appOrigin = $state<string | undefined>(undefined)
	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	onMount(() => {
		// Check if we have an origin parameter (coming from /connect)
		const origin = $page.url.searchParams.get('origin')
		if (origin) {
			appOrigin = origin
		}
	})

	async function handleCreatePasskey() {
		if (!accountName.trim()) {
			error = 'Please enter an account name'
			return
		}

		try {
			isProcessing = true
			error = undefined
			console.log('🔐 Creating passkey account...')

			// Create a new passkey - this will derive the Ethereum address from the credential
			console.log('📝 Creating new passkey for:', accountName)
			const swarmIdDomain = window.location.hostname
			const challenge = hexToUint8Array(keccak256(new TextEncoder().encode(swarmIdDomain)))
			const userIdIndex = accountsStore.accounts.filter(
				(account) => account.type === 'passkey',
			).length
			console.debug({ userIdIndex })
			const userId = `Swarm ID User / ${userIdIndex}`
			const account = await getOrCreatePasskeyAccount({
				rpName: 'Swarm ID',
				rpId: swarmIdDomain,
				challenge,
				userId,
				userName: accountName.trim(),
				userDisplayName: accountName.trim(),
			})
			console.log('✅ Passkey created successfully')

			// Store account WITHOUT masterKey (passkey accounts never persist masterKey)
			sessionStore.setAccount({
				id: account.ethereumAddress,
				createdAt: Date.now(),
				name: accountName.trim(),
				type: 'passkey',
			})

			// Keep masterKey in session ONLY (not in account)
			sessionStore.setTemporaryMasterKey(account.masterKey)
			console.log('🔑 MasterKey stored in session (temporary)')

			// Navigate to identity creation page
			if (appOrigin) {
				goto(`${routes.IDENTITY_NEW}?origin=${encodeURIComponent(appOrigin)}`)
			} else {
				goto(routes.IDENTITY_NEW)
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create passkey identity'
			console.error('❌ Passkey creation failed:', err)
			isProcessing = false
		}
	}
</script>

<CreationLayout
	title="Create account with Passkey"
	description="Create a new Swarm ID account using Passkey"
	onClose={() =>
		appOrigin
			? goto(`${routes.CONNECT}?origin=${encodeURIComponent(appOrigin)}`)
			: goto(routes.HOME)}
>
	{#snippet content()}
		<Vertical --vertical-gap="var(--padding)">
			{#if error}
				<Vertical
					--vertical-gap="var(--half-padding)"
					style="background: #fee; padding: var(--padding); border-radius: 4px; border: 1px solid #fcc;"
				>
					<Typography variant="small" style="color: #c00;">Error</Typography>
					<Typography variant="small">{error}</Typography>
				</Vertical>
			{/if}

			<Grid>
				<!-- Row 1 -->
				<Horizontal --horizontal-gap="var(--half-padding)"
					><FolderShared size={20} /><Typography>Account name</Typography></Horizontal
				>
				<Input
					variant="outline"
					dimension="compact"
					name="account-name"
					bind:value={accountName}
					placeholder="Enter account name"
					disabled={isProcessing}
				/>

				<!-- Row 2 -->
				<Typography>Authentication</Typography>
				<Horizontal --horizontal-gap="var(--half-padding)"
					><PasskeyLogo size={20} /><Typography>Passkey</Typography></Horizontal
				>
			</Grid>

			<Typography variant="small"
				>Your passkey will be used to derive a deterministic master key for your Swarm ID. Works
				with your device's biometric authentication or hardware security keys.</Typography
			>
		</Vertical>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={handleCreatePasskey} disabled={isProcessing}>
			{isProcessing ? 'Creating...' : 'Confirm with Passkey'}
			{#if !isProcessing}<ArrowRight />{/if}
		</Button>
	{/snippet}
</CreationLayout>
