<script lang="ts">
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import Typography from '$lib/components/ui/typography.svelte'

	// Get identities from store
	const identities = $derived(identitiesStore.identities)
	const hasIdentities = $derived(identities.length > 0)

	let showCreateMode = $state(false)

	function handleCreateNew() {
		showCreateMode = true
	}
</script>

<Vertical>
	<Typography variant="h4">Welcome to Swarm ID</Typography>

	{#if hasIdentities && !showCreateMode}
		<Typography variant="small">Choose an identity to continue</Typography>
		<Vertical --vertical-gap="var(--double-padding)">
			<IdentityList {identities} />
			<Horizontal --justify-content="flex-start">
				<Button variant="ghost" dimension="compact" onclick={handleCreateNew}
					>Connect another account</Button
				>
			</Horizontal>
		</Vertical>
	{:else}
		<Typography variant="small">Create or import an account to continue</Typography>
		<CreateNewIdentity />
	{/if}
</Vertical>
