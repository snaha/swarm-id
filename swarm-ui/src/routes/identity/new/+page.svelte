<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import { FolderShared } from 'carbon-icons-svelte'
	import routes from '$lib/routes'
	import Hashicon from '$lib/components/hashicon.svelte'
	import BxCheck from '$lib/components/boxicons/bx-check.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { goto } from '$app/navigation'
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'

	let idName = $state('')
	let appOrigin = $state<string | undefined>(undefined)
	let accountName = $state('')

	onMount(() => {
		// Get origin parameter if coming from /connect
		const origin = $page.url.searchParams.get('origin')
		if (origin) {
			appOrigin = origin
		}

		// Retrieve account creation data from session store
		const sessionData = sessionStore.data
		if (sessionData.accountName) {
			accountName = sessionData.accountName
			// Derive initial ID name from account name
			idName = sessionData.accountName
		}

		if (!sessionData.prfOutput) {
			console.error('❌ No PRF output available in session')
		}
	})

	function handleCreateIdentity() {
		const sessionData = sessionStore.data

		if (!sessionData.prfOutput) {
			console.error('❌ No PRF output available')
			return
		}

		if (!sessionData.accountName) {
			console.error('❌ No account name available')
			return
		}

		// Create the account with the master key
		const account = accountsStore.addAccount({
			name: sessionData.accountName,
			type: 'passkey',
			masterKey: sessionData.prfOutput,
			ethereumAddress: sessionData.ethereumAddress,
		})

		console.log('✅ Account created:', account.id)

		// Create the identity
		const identity = identitiesStore.addIdentity({
			accountId: account.id,
			name: idName,
		})

		console.log('✅ Identity created:', identity.id)

		// Set as current account and identity
		sessionStore.setCurrentAccount(account.id)
		sessionStore.setCurrentIdentity(identity.id)

		// Clear the temporary account creation data
		sessionStore.clearAccountCreationData()

		// Navigate back to /connect
		if (appOrigin) {
			goto(`${routes.CONNECT}?origin=${encodeURIComponent(appOrigin)}`)
		} else {
			goto(routes.CONNECT)
		}
	}
</script>

<CreationLayout
	title="Identity"
	description="Create a first identity associated with your Swarm ID account"
	onBack={() => history.back()}
	onClose={() => goto(routes.HOME)}
>
	{#snippet content()}
		<Grid>
			<!-- Row 1 -->
			<Horizontal --horizontal-gap="var(--half-padding)"
				><FolderShared size={20} /><Typography>Account</Typography></Horizontal
			>
			<Input variant="outline" dimension="compact" name="account" value={accountName} readonly />

			<!-- Row 2 -->
			<Typography>ID name</Typography>
			<Horizontal --horizontal-gap="var(--half-padding)">
				<Input variant="outline" dimension="compact" name="id-name" bind:value={idName} />
				{#if idName}
					<Hashicon value={idName} size={40} />
				{/if}
			</Horizontal>
		</Grid>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={handleCreateIdentity}>
			<BxCheck />Create and connect</Button
		>
	{/snippet}
</CreationLayout>
