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
	import { goto } from '$app/navigation'
	import { onMount } from 'svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import type { Identity, Account } from '$lib/types'
	import { HDNodeWallet } from 'ethers'
	import { generateDockerName } from '$lib/docker-name'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Divider from '$lib/components/ui/divider.svelte'
	import ResponsiveLayout from '$lib/components/ui/responsive-layout.svelte'
	import { layoutStore } from '$lib/stores/layout.svelte'

	let idName = $state('')
	let accountName = $state('')

	// Derive identity using temporary masterKey from session
	const derivedIdentity = $derived.by(() => {
		const account = sessionStore.data.account
		const tempMasterKey = sessionStore.data.temporaryMasterKey

		if (!account || !tempMasterKey) {
			return undefined
		}

		const index = identitiesStore.identities.filter(
			(identity) => identity.accountId === account.id,
		).length

		return deriveIdentityFromAccount(account, tempMasterKey, index)
	})

	onMount(() => {
		const account = sessionStore.data.account
		if (account) {
			accountName = account.name
		}

		idName = derivedIdentity?.name ?? ''
	})

	const hasSessionData = $derived(
		sessionStore.data.account !== undefined && sessionStore.data.temporaryMasterKey !== undefined,
	)

	function deriveIdentityFromAccount(account: Account, masterKey: string, index: number) {
		const identityWallet = HDNodeWallet.fromSeed(masterKey).deriveChild(index)
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

	function handleCreateIdentity() {
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

		// Create the identity
		const identity = identitiesStore.addIdentity({
			...derivedIdentity,
		})

		console.log('✅ Identity created:', identity.id)

		// Set as current account and identity
		sessionStore.setCurrentAccount(account.id)
		sessionStore.setCurrentIdentity(identity.id)

		// Navigate back to /connect or home
		if (sessionStore.data.appOrigin) {
			goto(routes.CONNECT)
		} else {
			// Clear temporary masterKey for security
			sessionStore.clearTemporaryMasterKey()

			goto(routes.HOME)
		}
	}
</script>

<CreationLayout title="Create identity" onClose={() => goto(routes.HOME)}>
	{#snippet content()}
		{#if !hasSessionData}
			<Typography>No account data found. Please start from the home page.</Typography>
		{:else}
			<Vertical --vertical-gap="var(--padding)">
				<ResponsiveLayout
					--responsive-align-items="start"
					--responsive-justify-content="stretch"
					--responsive-gap="var(--quarter-padding)"
				>
					<Horizontal
						class={!layoutStore.mobile ? 'flex50 input-layout' : ''}
						--horizontal-gap="var(--half-padding)"
						><FolderShared size={20} /><Typography>Account</Typography></Horizontal
					>
					<Input
						variant="outline"
						dimension="compact"
						name="account"
						value={accountName}
						disabled
						class="flex50"
					/>
				</ResponsiveLayout>

				<ResponsiveLayout
					--responsive-align-items="start"
					--responsive-justify-content="stretch"
					--responsive-gap="var(--quarter-padding)"
				>
					<!-- Row 2 -->
					<Typography class={!layoutStore.mobile ? 'flex50 input-layout' : ''}
						>Identity display name</Typography
					>
					<Vertical
						class={!layoutStore.mobile ? 'flex50' : ''}
						--vertical-gap="var(--quarter-gap)"
						--vertical-align-items={layoutStore.mobile ? 'stretch' : 'start'}
					>
						<Horizontal --horizontal-gap="var(--half-padding)">
							<Input
								variant="outline"
								dimension="compact"
								name="id-name"
								bind:value={idName}
								class="grower"
							/>
							{#if derivedIdentity}
								<Hashicon value={derivedIdentity.id} size={40} />
							{/if}
						</Horizontal>
						<Typography variant="small">
							This is how your identity will appear in your Swarm ID account and apps you connect to
						</Typography>
					</Vertical>
				</ResponsiveLayout>
			</Vertical>
			<Divider --margin="0" />
		{/if}
	{/snippet}

	{#snippet buttonContent()}
		{#if hasSessionData}
			<Button dimension="compact" onclick={handleCreateIdentity} disabled={!derivedIdentity}>
				<Checkmark />Create and connect</Button
			>
		{/if}
	{/snippet}
</CreationLayout>

<style>
	:global(.flex50) {
		flex: 0.5;
	}
	:global(.input-layout) {
		padding: var(--half-padding) 0 !important;
		border: 1px solid transparent;
	}
</style>
