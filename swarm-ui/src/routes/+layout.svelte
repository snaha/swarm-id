<script lang="ts">
	import '../app.pcss'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'
	import { SidePanelOpen } from 'carbon-icons-svelte'
	import { page } from '$app/state'
	import routes from '$lib/routes'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'

	let { children } = $props()

	const identityId = $derived(page.params.id)
	const identity = $derived(identitiesStore.getIdentity(identityId))
	const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)

	let drawerOpen = $state(false)
</script>

<div class="page-wrapper">
	<Vertical
		--vertical-justify-content="flex-start"
		--vertical-gap="var(--double-padding)"
		style="flex: 1; padding: var(--double-padding);"
	>
		<Horizontal
			--horizontal-justify-content="space-between"
			--horizontal-align-items="center"
			style="width: 100%;"
		>
			<div class="logo">
				<a href={routes.HOME}>
					<SwarmLogo fill="#242424" height={30} />
				</a>
			</div>

			{#if identity && account && !drawerOpen}
				<Horizontal
					--horizontal-gap="var(--half-padding)"
					--horizontal-align-items="center"
					onclick={() => (drawerOpen = true)}
				>
					<Hashicon value={identity.id} size={32} />
					<Vertical --vertical-gap="0">
						<Typography variant="small">{account.name}</Typography>
						<Typography>{identity.name}</Typography>
					</Vertical>
				</Horizontal>
			{/if}
		</Horizontal>

		{@render children()}
	</Vertical>

	{#if identity && account && drawerOpen}
		<div class="drawer">
			<Vertical --vertical-gap="var(--double-padding)">
				<Horizontal
					--horizontal-gap="var(--double-padding)"
					--horizontal-justify-content="space-between"
					--horizontal-align-items="center"
				>
					<Button
						variant="ghost"
						dimension="compact"
						onclick={() => (drawerOpen = false)}
						aria-label="Close drawer"
					>
						<SidePanelOpen size={20} />
					</Button>
					<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
						<Hashicon value={identity.id} size={32} />
						<Vertical --vertical-gap="0">
							<Typography variant="small">{account.name}</Typography>
							<Typography>{identity.name}</Typography>
						</Vertical>
					</Horizontal>
				</Horizontal>
			</Vertical>
		</div>
	{/if}
</div>

<style>
	.page-wrapper {
		display: flex;
		flex-direction: row;
		min-height: 100vh;
		background: var(--colors-ultra-low);
		position: relative;
		align-items: stretch;
		justify-content: space-around;
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
</style>
