<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import CollapsibleSection from '$lib/components/collapsible-section.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import type { Identity } from '$lib/types'

	interface Props {
		identities: Identity[]
		appUrl: string
		onIdentityClick?: (identity: Identity) => void
	}

	let { identities, appUrl, onIdentityClick }: Props = $props()

	const connectedIdentityIds = $derived(connectedAppsStore.getConnectedIdentityIds(appUrl))

	const previouslyConnected = $derived(
		identities.filter((identity) => connectedIdentityIds.includes(identity.id)),
	)

	const otherIdentities = $derived(
		identities.filter((identity) => !connectedIdentityIds.includes(identity.id)),
	)

	const hasPreviouslyConnected = $derived(previouslyConnected.length > 0)
	const hasOtherIdentities = $derived(otherIdentities.length > 0)
</script>

{#if hasPreviouslyConnected}
	<!-- Show grouped view with collapsible sections -->
	<Vertical --vertical-gap="var(--padding)">
		<CollapsibleSection title="Previously connected" count={previouslyConnected.length}>
			<IdentityList identities={previouslyConnected} {onIdentityClick} />
		</CollapsibleSection>

		{#if hasOtherIdentities}
			<CollapsibleSection title="Other identities" count={otherIdentities.length} expanded={false}>
				<IdentityList identities={otherIdentities} {onIdentityClick} />
			</CollapsibleSection>
		{/if}
	</Vertical>
{:else}
	<!-- No previously connected identities, show regular list -->
	<IdentityList {identities} {onIdentityClick} />
{/if}
