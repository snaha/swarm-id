<script lang="ts">
	import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'

	// Get identities from store
	const identities = $derived(identitiesStore.identities)
	const hasIdentities = $derived(identities.length > 0)

	let showCreateMode = $state(false)

	function handleCreateNew() {
		showCreateMode = true
	}

	function handleBackToList() {
		showCreateMode = false
	}
</script>

<ConnectedAppHeader appName="Coucou" appUrl="https://coucou.mail" />

{#if hasIdentities && !showCreateMode}
	<Vertical --vertical-gap="var(--double-padding)">
		<IdentityList {identities} />
		<Horizontal --justify-content="flex-start">
			<Button variant="ghost" dimension="compact" onclick={handleCreateNew}
				>Connect another account</Button
			>
		</Horizontal>
	</Vertical>
{:else}
	<Vertical --vertical-gap="var(--double-padding)">
		{#if hasIdentities}
			<Horizontal --justify-content="flex-start">
				<Button variant="ghost" dimension="compact" onclick={handleBackToList}
					>Back to identities</Button
				>
			</Horizontal>
		{/if}
		<CreateNewIdentity />
	</Vertical>
{/if}
