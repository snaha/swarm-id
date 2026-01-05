<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import type { ConnectedApp, Identity } from '$lib/types'
	import { DEFAULT_SESSION_DURATION } from '$lib/types'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import Badge from './ui/badge.svelte'
	import Dropdown from './ui/dropdown.svelte'
	import { OverflowMenuVertical, TrashCan, Unlink } from 'carbon-icons-svelte'
	import List from './ui/list/list.svelte'
	import ListItem from './ui/list/list-item.svelte'
	import DeleteModal from './delete-modal.svelte'
	import { SWARM_SECRET_PREFIX } from '@swarm-id/lib'

	interface Props {
		apps: ConnectedApp[]
		identity: Identity
	}

	let { apps, identity }: Props = $props()

	let showConfirmRevokeApp = $state(false)
	let appToBeRevoked = $state<ConnectedApp | undefined>()

	function isAppConnected(app: ConnectedApp, now = Date.now()) {
		return app.connectedUntil
			? app.connectedUntil > now
			: app.lastConnectedAt + (identity.settings?.appSessionDuration ?? DEFAULT_SESSION_DURATION) >
					now
	}

	function disconnectApp(app: ConnectedApp) {
		connectedAppsStore.disconnectApp(app.appUrl, app.identityId)
		localStorage.removeItem(`${SWARM_SECRET_PREFIX}${app.appUrl}`)
	}

	function confirmRevokeApp(app: ConnectedApp) {
		appToBeRevoked = app
		showConfirmRevokeApp = true
	}

	function revokeApp(app: ConnectedApp) {
		disconnectApp(app)
		connectedAppsStore.removeApp(app.appUrl, app.identityId)
	}
</script>

<Vertical --vertical-gap="0" style="border: 1px solid var(--colors-low);">
	{#each apps as app (app.appUrl)}
		<div class="app-item" role="button" tabindex="-1">
			<Horizontal
				--horizontal-gap="var(--half-padding)"
				--horizontal-align-items="center"
				--horizontal-justify-content="space-between"
			>
				{#if app.appIcon}
					<img src={app.appIcon} alt={app.appName} class="app-icon" />
				{:else}
					<div class="app-icon-placeholder">{app.appName.charAt(0).toUpperCase()}</div>
				{/if}
				<Vertical --vertical-gap="0" style="flex: 1;">
					<Typography variant="h5">
						{app.appName}
					</Typography>
					<Typography variant="small">
						{app.appUrl}
					</Typography>
				</Vertical>
				<Horizontal --horizontal-gap="var(--half-padding)">
					{#if isAppConnected(app)}
						<Badge dimension="small">Connected</Badge>
					{/if}
					<Dropdown buttonVariant="ghost" buttonDimension="compact" left>
						{#snippet button()}
							<OverflowMenuVertical size={20} />
						{/snippet}
						<List>
							<ListItem onclick={() => disconnectApp(app)}>
								<Unlink size={20} />
								Disconnect app
							</ListItem>
							<ListItem danger onclick={() => confirmRevokeApp(app)}>
								<TrashCan size={20} />
								Revoke app
							</ListItem>
						</List>
					</Dropdown>
				</Horizontal>
			</Horizontal>
		</div>
	{/each}
</Vertical>

<DeleteModal
	confirm={() => appToBeRevoked && revokeApp(appToBeRevoked)}
	title="Are you sure you want to revoke the app?"
	text=""
	buttonTitle="Revoke"
	bind:open={showConfirmRevokeApp}
	oncancel={() => (showConfirmRevokeApp = false)}
/>

<style>
	.app-item {
		padding: var(--half-padding);
		border-bottom: 1px solid var(--colors-low);
		background: var(--colors-card-bg);
		cursor: pointer;
	}

	.app-item:hover,
	.app-item:focus {
		background: var(--colors-base);
	}

	.app-item:focus {
		outline: var(--focus-outline);
		outline-offset: var(--focus-outline-offset);
	}

	.app-item:last-child {
		border-bottom: none;
	}

	.app-icon {
		width: 40px;
		height: 40px;
		object-fit: contain;
	}

	.app-icon-placeholder {
		width: 40px;
		height: 40px;
		background: var(--colors-low);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		color: var(--colors-ultra-high);
	}
</style>
