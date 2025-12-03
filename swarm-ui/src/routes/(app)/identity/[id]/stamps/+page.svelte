<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import CollapsibleSection from '$lib/components/collapsible-section.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { page } from '$app/stores'
	import Divider from '$lib/components/ui/divider.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import { goto } from '$app/navigation'

	const identityId = $derived($page.params.id)
	const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
	const stamps = $derived(identityId ? postageStampsStore.getStampsByIdentity(identityId) : [])

	function makeDefaultStamp(batchID: string) {
		if (!identityId) return
		identitiesStore.setDefaultStamp(identityId, batchID)
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

	function removeStamp(batchID: string) {
		if (!identityId) return
		// If this is the default stamp, clear the default stamp first
		if (identity?.defaultPostageStampBatchID === batchID) {
			identitiesStore.setDefaultStamp(identityId, undefined)
		}
		postageStampsStore.removeStamp(batchID)
	}
</script>

<Vertical --vertical-gap="var(--padding)" style="padding-top: var(--double-padding);">
	{#if stamps.length > 0}
		<Typography
			>You have {stamps.length} Swarm postage stamp{stamps.length === 1 ? '' : 's'} in use with this identity</Typography
		>
		<Vertical --vertical-gap="0">
			<Divider />
			{#each stamps as stamp (stamp.batchID)}
				{@const isDefault = identity?.defaultPostageStampBatchID === stamp.batchID}
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
									onclick={() => makeDefaultStamp(stamp.batchID)}
									disabled={isDefault}
								>
									Make default
								</Button>
								<Button dimension="compact" variant="ghost">Top up stamp</Button>
							</Horizontal>
							<Button
								dimension="compact"
								variant="ghost"
								onclick={() => removeStamp(stamp.batchID)}
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
		<Button
			dimension="compact"
			variant="ghost"
			onclick={() => goto(`/identity/${identityId}/stamps/new`)}
		>
			Add postage stamp
		</Button>
	</Horizontal>
</Vertical>
