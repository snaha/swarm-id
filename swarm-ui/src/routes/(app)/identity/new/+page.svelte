<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import FolderShared from 'carbon-icons-svelte/lib/FolderShared.svelte'
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
	import routes from '$lib/routes'
	import Hashicon from '$lib/components/hashicon.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { goto } from '$app/navigation'
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import type { Identity, Account, DistributiveOmit } from '$lib/types'
	import { HDNodeWallet } from 'ethers'

	let idName = $state('')
	let appOrigin = $state<string | undefined>(undefined)
	let accountName = $state('')
	const derivedIdentity = sessionStore.data.account
		? deriveIdentityFromAccount(sessionStore.data.account, identitiesStore.identities.length)
		: undefined

	onMount(() => {
		// Get origin parameter if coming from /connect
		const origin = $page.url.searchParams.get('origin')
		if (origin) {
			appOrigin = origin
		}

		// Retrieve account creation data from session store
		const account = sessionStore.data.account
		if (account) {
			accountName = account.name
		}

		idName = derivedIdentity?.name ?? ''
	})

	function deriveIdentityFromAccount(
		account: DistributiveOmit<Account, 'id' | 'createdAt'>,
		index: number
	) {
		// No null checks needed - account object is already validated
		console.debug({ account })

		const identityWallet = HDNodeWallet.fromSeed(account.masterKey).deriveChild(index)
		const id = identityWallet.address
		const name = id.slice(2, 10)
		const accountId = account.masterAddress
		const createdAt = Date.now()
		const identity: Identity = {
			id,
			accountId,
			name,
			createdAt
		}
		return identity
	}

	function handleCreateIdentity() {
		const sessionAccount = sessionStore.data.account
		if (!sessionAccount) {
			console.error('❌ No account data in session')
			return
		}

		if (!derivedIdentity) {
			console.error('❌ No derived identity available')
			return
		}

		// Create the account with the master key
		const account = accountsStore.addAccount(sessionAccount)

		console.log('✅ Account created:', account.id)

		// Create the identity
		const identity = identitiesStore.addIdentity({
			...derivedIdentity,
		})

		console.log('✅ Identity created:', identity.id)

		// Set as current account and identity
		sessionStore.setCurrentAccount(account.id)
		sessionStore.setCurrentIdentity(identity.id)

		// Clear the account creation data
		sessionStore.clearAccount()

		// Navigate back to /connect
		if (appOrigin) {
			goto(`${routes.CONNECT}?origin=${encodeURIComponent(appOrigin)}`)
		} else {
			goto(routes.HOME)
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
				{#if derivedIdentity}
					<Hashicon value={derivedIdentity.id} size={40} />
				{/if}
			</Horizontal>
		</Grid>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={handleCreateIdentity} disabled={!derivedIdentity}>
			<Checkmark />Create and connect</Button
		>
	{/snippet}
</CreationLayout>
