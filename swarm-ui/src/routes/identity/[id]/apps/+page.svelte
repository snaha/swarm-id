<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import CollapsibleSection from '$lib/components/collapsible-section.svelte'
	import AppList from '$lib/components/app-list.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { page } from '$app/stores'
	import Divider from '$lib/components/ui/divider.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import Toggle from '$lib/components/ui/toggle.svelte'

	const identityId = $derived($page.params.id)
	const identity = $derived(identitiesStore.getIdentity(identityId))
	const apps = $derived(connectedAppsStore.getAppsByIdentityId(identityId))
	const stamps = $derived(postageStampsStore.getStampsByIdentity(identityId))

	let defaultStampBatchID = $state<string | undefined>(undefined)

	// Sync local state with store
	$effect(() => {
		defaultStampBatchID = identity?.defaultPostageStampBatchID
	})

	// Update store when local state changes
	$effect(() => {
		if (defaultStampBatchID && defaultStampBatchID !== identity?.defaultPostageStampBatchID) {
			identitiesStore.setDefaultStamp(identityId, defaultStampBatchID)
		}
	})

	function formatBatchId(batchId: string): string {
		return batchId.slice(0, 8)
	}
</script>

<Vertical --vertical-gap="var(--padding)" style="padding-top: var(--double-padding);">
	<CollapsibleSection
		title="Default permissions"
		subtitle="Set default permissions for all apps (except overridden)"
	>
		<Grid>
			<!-- Row 1-->
			<Typography>Keep apps connected for</Typography>
			<Select
				dimension="compact"
				value="30d"
				items={[
					{ value: 'session', label: 'Current session' },
					{ value: '24h', label: '24 hours' },
					{ value: '7d', label: '7 days' },
					{ value: '30d', label: '30 days' },
				]}
			></Select>

			<!-- Row 2-->
			<Typography>Default postage stamp</Typography>
			<Select
				dimension="compact"
				bind:value={defaultStampBatchID}
				items={stamps.map((s) => ({ value: s.batchID, label: formatBatchId(s.batchID) }))}
				placeholder={stamps.length === 0 ? 'No stamps available' : undefined}
				disabled={stamps.length === 0}
			></Select>
		</Grid>
		<Vertical --vertical-gap="0">
			<Toggle label="Auto-approve messages" checked></Toggle>
			<Typography variant="small" style="opacity: 0.5;"
				>Auto-approve signing messages from connected apps</Typography
			>
		</Vertical>
		<Vertical --vertical-gap="0">
			<Toggle label="Auto-approve transactions"></Toggle>
			<Typography variant="small" style="opacity: 0.5;"
				>Auto-approve transaction requests from connected apps</Typography
			>
		</Vertical>
	</CollapsibleSection>
	<Divider />
	<CollapsibleSection
		title="Apps"
		subtitle="Override permissions for a specific app"
		count={apps.length}
	>
		{#if apps.length > 0}
			<AppList {apps} />
		{:else}
			<Typography variant="small" style="opacity: 0.5;">No connected apps yet.</Typography>
		{/if}
	</CollapsibleSection>
</Vertical>
