<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import TabBar from '$lib/components/ui/tab-bar/tab-bar.svelte'
	import TabContent from '$lib/components/ui/tab-bar/tab-content.svelte'
	import CollapsibleSection from '$lib/components/collapsible-section.svelte'
	import AppList from '$lib/components/app-list.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { page } from '$app/stores'
	import Divider from '$lib/components/ui/divider.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import Toggle from '$lib/components/ui/toggle.svelte'
	import Input from '$lib/components/ui/input/input.svelte'

	// Get identities from store
	const identityId = $derived($page.params.id)
	const identity = $derived(identitiesStore.getIdentity(identityId))
	const apps = $derived(connectedAppsStore.getAppsByIdentityId(identityId))
	const stamps = $derived(postageStampsStore.getStampsByIdentity(identityId))

	// Convert stamps to Select items
	const stampItems = $derived(
		stamps.map((stamp) => ({
			value: stamp.id,
			label: formatBatchId(stamp.batchID),
		})),
	)

	function makeDefaultStamp(stampId: string) {
		identitiesStore.setDefaultStamp(identityId, stampId)
	}

	function handleDefaultStampChange(value: string) {
		identitiesStore.setDefaultStamp(identityId, value)
	}

	function formatCapacity(utilization: number, depth: number): string {
		const totalChunks = Math.pow(2, depth)
		const chunkSize = 4096 // 4KB per chunk
		const totalBytes = totalChunks * chunkSize
		const usedBytes = totalBytes * utilization

		const formatBytes = (bytes: number): string => {
			if (bytes < 1024) return `${bytes} B`
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
			if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
			return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
		}

		return `${formatBytes(usedBytes)} of ${formatBytes(totalBytes)} used`
	}

	function formatBatchId(batchId: string): string {
		return batchId.slice(0, 8)
	}

	function removeStamp(stampId: string) {
		// If this is the default stamp, clear the default stamp first
		if (identity?.defaultPostageStampId === stampId) {
			identitiesStore.setDefaultStamp(identityId, undefined)
		}
		postageStampsStore.removeStamp(stampId)
	}
</script>

<Vertical>
	<TabBar>
		<TabContent value="Apps">
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
							value={identity?.defaultPostageStampId}
							items={stamps.map(s => ({ value: s.batchID, label: formatBatchId(s.batchID) }))}
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
		</TabContent>
		<TabContent value="Stamps">
			<Vertical --vertical-gap="var(--padding)" style="padding-top: var(--double-padding);">
				{#if stamps.length > 0}
					<Typography
						>You have {stamps.length} Swarm postage stamp{stamps.length === 1 ? '' : 's'} in use with
						this identity</Typography
					>
					<Vertical --vertical-gap="0">
						<Divider />
						{#each stamps as stamp}
							{@const isDefault = identity?.defaultPostageStampId === stamp.id}
							<CollapsibleSection
								title={formatBatchId(stamp.batchID)}
								count={isDefault ? 'default' : undefined}
								expanded={false}
							>
								<Vertical --vertical-gap="var(--half-padding)">
									<Horizontal --horizontal-justify-content="space-between">
										<Typography>Stamp ID</Typography>
										<Input variant="outline" dimension="compact" value={stamp.batchID} readonly />
									</Horizontal>
									<Horizontal --horizontal-justify-content="space-between">
										<Typography>Depth</Typography>
										<Typography>{stamp.depth}</Typography>
									</Horizontal>
									<Horizontal --horizontal-justify-content="space-between">
										<Typography>Capacity</Typography>
										<Typography
											>{formatCapacity(stamp.utilization, stamp.depth)}({(
												stamp.utilization * 100
											).toFixed(1)}%)</Typography
										>
									</Horizontal>
									<Horizontal --horizontal-justify-content="space-between">
										<Horizontal --horizontal-justify-content="flex-start">
											<Button
												dimension="compact"
												variant="ghost"
												onclick={() => makeDefaultStamp(stamp.id)}
												disabled={isDefault}
											>
												Make default
											</Button>
											<Button dimension="compact" variant="ghost">Top up stamp</Button>
										</Horizontal>
										<Button
											dimension="compact"
											variant="ghost"
											onclick={() => removeStamp(stamp.id)}
										>
											Remove stamp
										</Button>
									</Horizontal>
								</Vertical>
							</CollapsibleSection>
							<Divider />
						{/each}
					</Vertical>
				{:else}
					<Typography variant="small" style="opacity: 0.5;">No postage stamps yet.</Typography>
				{/if}

				<Horizontal>
					<Button dimension="compact" variant='ghost'>Add postage stamp</Button>
				</Horizontal>
			</Vertical>
		</TabContent>
		<TabContent value="Identity">
			<div>Settings content goes here.</div>
		</TabContent>
	</TabBar>
</Vertical>
