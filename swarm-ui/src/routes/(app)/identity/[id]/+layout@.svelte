<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'
	import { SidePanelOpen } from 'carbon-icons-svelte'
	import { page } from '$app/stores'
	import routes from '$lib/routes'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'

	let { children } = $props()

	const identityId = $derived($page.params.id)
	const currentPath = $derived($page.url.pathname)
	const identity = $derived(identitiesStore.getIdentity(identityId))
	const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)

	let drawerOpen = $state(false)

	const tabs = $derived([
		{ label: 'Apps', href: routes.IDENTITY_APPS(identityId) },
		{ label: 'Stamps', href: routes.IDENTITY_STAMPS(identityId) },
		{ label: 'Settings', href: routes.IDENTITY_SETTINGS(identityId) },
	])
</script>

<div class="page-content">
	<div class="content-area tab-container">
		<ul>
			{#each tabs as tab}
				<li>
					<Button
						variant="ghost"
						dimension="default"
						active={currentPath === tab.href}
						href={tab.href}
					>
						{tab.label}
					</Button>
				</li>
			{/each}
		</ul>
		<div class="tab-content">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.page-wrapper {
		display: flex;
		flex-direction: row;
		min-height: 100vh;
		background: var(--colors-ultra-low);
		position: relative;
		align-items: flex-start;
		justify-content: space-around;
	}
	.page-content {
		flex: 1;
		display: flex;
		justify-content: center;
		padding-top: var(--double-padding);
		flex-direction: column;
		justify-content: flex-start;
		align-items: center;
		gap: var(--double-padding);
	}
	.drawer {
		width: 360px;
		min-height: 100vh;
		background: var(--colors-base);
		border-left: 1px solid var(--colors-low);
		padding: var(--double-padding);
		overflow-y: auto;
		z-index: 50;
	}

	.content-area {
		max-width: 560px;
	}

	ul {
		display: flex;
		flex-direction: row;
		justify-content: flex-start;
		gap: 0;
		margin-top: 0px;
		margin-bottom: 0px;
		padding-left: unset;
		list-style: none;
		border: 1px solid var(--colors-low);
	}

	li {
		flex: 1;
		margin: 0;
		padding: 0;
	}

	li a {
		text-decoration: none;
		display: block;
		margin: 0;
		padding: 0;
	}

	li :global(button),
	li :global(a) {
		border-radius: 0;
		color: var(--colors-ultra-high);
		text-transform: uppercase;
		font-weight: 700;
		padding: var(--half-padding) !important;
		margin: 0 !important;
		width: 100%;
	}

	li :global(.root) {
		margin: 0;
		padding: 0;
	}

	li :global(button.active),
	li :global(a.active),
	li :global(button.ghost.active),
	li :global(a.ghost.active) {
		background: var(--colors-low) !important;
		color: var(--colors-high) !important;
	}

	.tab-container {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.tab-content {
		display: flex;
		flex-direction: column;
	}
</style>
