<script lang="ts">
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import CreateIdentityButton from '$lib/components/create-identity-button.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import AccountSelector from '$lib/components/account-selector.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { goto } from '$app/navigation'
	import type { Identity } from '$lib/types'
	import routes from '$lib/routes'

	let selectedAccountId = $state<string | undefined>(undefined)

	// Get identities from store, filtered by selected account
	const allIdentities = $derived(identitiesStore.identities)
	const identities = $derived(
		selectedAccountId
			? allIdentities.filter((identity) => identity.accountId === selectedAccountId)
			: allIdentities,
	)
	const hasIdentities = $derived(identities.length > 0)

	let showCreateMode = $state(false)

	function handleCreateNew() {
		showCreateMode = true
	}

	function handleIdentityClick(identity: Identity) {
		goto(routes.IDENTITY(identity.id))
	}
</script>

<Vertical>
	<Typography variant="h4">Welcome to Swarm ID</Typography>

	{#if hasIdentities && !showCreateMode}
		<Typography variant="small">Choose an identity to continue</Typography>
		<Vertical --vertical-gap="var(--double-padding)">
			<AccountSelector bind:selectedAccountId onCreateAccount={handleCreateNew} />
			<IdentityList {identities} onIdentityClick={handleIdentityClick} />
			<Horizontal --horizontal-justify-content="flex-start">
				<CreateIdentityButton accountId={selectedAccountId} />
			</Horizontal>
		</Vertical>
	{:else}
		<Typography variant="small">Create or import an account to continue</Typography>
		<CreateNewIdentity />
	{/if}
</Vertical>
