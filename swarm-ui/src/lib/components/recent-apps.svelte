<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Divider from '$lib/components/ui/divider.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import Time from 'carbon-icons-svelte/lib/Time.svelte'

	let { limit = 5, currentAppUrl }: { limit?: number; currentAppUrl?: string } = $props()

	const recentApps = $derived(
		connectedAppsStore
			.getRecentApps()
			.filter((app) => app.appUrl !== currentAppUrl)
			.slice(0, limit),
	)
	const hasRecentApps = $derived(recentApps.length > 0)

	function formatDate(timestamp: number): string {
		const date = new Date(timestamp)
		const now = new Date()
		const diffMs = now.getTime() - date.getTime()
		const diffMins = Math.floor(diffMs / 60000)
		const diffHours = Math.floor(diffMs / 3600000)
		const diffDays = Math.floor(diffMs / 86400000)

		if (diffMins < 1) return 'just now'
		if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`
		if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
		if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
		return date.toLocaleDateString()
	}
</script>

{#if hasRecentApps}
	<Vertical --vertical-gap="var(--padding)">
		<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
			<Time size={16} />
			<Typography variant="small" font="mono">Previously connected apps</Typography>
		</Horizontal>

		<Vertical --vertical-gap="0" style="border: 1px solid var(--colors-low);">
			{#each recentApps as app (app.appUrl + app.identityId)}
				<div class="app-item">
					<Vertical --vertical-gap="var(--quarter-padding)">
						<Typography>{app.appName}</Typography>
						<Typography variant="small" font="mono">{app.appUrl}</Typography>
						<Typography variant="small"
							>Last connected: {formatDate(app.lastConnectedAt)}</Typography
						>
					</Vertical>
				</div>
			{/each}
		</Vertical>

		<Divider />
	</Vertical>
{/if}

<style>
	.app-item {
		padding: var(--half-padding);
		border-bottom: 1px solid var(--Low, #e7e7e7);
		background: var(--colors-card-bg);
	}

	.app-item:last-child {
		border-bottom: none;
	}
</style>
