<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { authenticateWithPasskey, createPasskeyIdentity } from '$lib/passkey'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import BxRightArrowAlt from '$lib/components/boxicons/bx-right-arrow-alt.svelte'
	import { FolderShared } from 'carbon-icons-svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'

	let accountName = $state('')
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
			console.log('🔐 Creating passkey identity...')

			// Create a new passkey
			console.log('📝 Creating new passkey for:', accountName)
			let identity = await createPasskeyIdentity({
				rpName: 'Swarm ID',
				rpId: window.location.hostname,
				userName: accountName.trim(),
				userDisplayName: accountName.trim(),
			})
			console.log('✅ Passkey created successfully')

			// After creating, authenticate to get the PRF output
			identity = await authenticateWithPasskey({
				rpId: window.location.hostname,
			})

			if (!identity.prfOutput) {
				throw new Error(
					'PRF extension not available. Please use a modern browser (Chrome 128+, Safari 18+) with passkey support.',
				)
			}

			// Convert PRF output to hex string
			const prfHex = Array.from(identity.prfOutput)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')

			console.log('🔑 PRF output from passkey:', prfHex.substring(0, 16) + '...')
			console.log('📍 Ethereum Address:', identity.ethereumAddress)

			// Store account creation data in session store
			sessionStore.setAccountCreationData({
				accountName: accountName.trim(),
				prfOutput: prfHex,
				ethereumAddress: identity.ethereumAddress,
			})

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
				>Your passkey will be used to derive a deterministic master key for your Swarm ID. This key
				is secured by your device's biometric authentication.</Typography
			>
		</Vertical>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={handleCreatePasskey} disabled={isProcessing}>
			{isProcessing ? 'Creating...' : 'Create Identity'}
			{#if !isProcessing}<BxRightArrowAlt />{/if}
		</Button>
	{/snippet}
</CreationLayout>
