<script lang="ts">
	import '../app.pcss'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'
	import { page } from '$app/state'
	import routes from '$lib/routes'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import Drawer from '$lib/components/drawer.svelte'

	let { children } = $props()

	const identityId = $derived(page.params.id)
	const identity = $derived(identityId ? identitiesStore.getIdentity(identityId) : undefined)
	const identities = $derived(identitiesStore.identities)
	const account = $derived(identity ? accountsStore.getAccount(identity.accountId) : undefined)

	// Initialize drawer state from localStorage
	let drawerOpen = $state(
		typeof window !== 'undefined' ? localStorage.getItem('drawerOpen') === 'true' : false,
	)

	// Persist drawer state to localStorage whenever it changes
	$effect(() => {
		if (typeof window !== 'undefined') {
			localStorage.setItem('drawerOpen', String(drawerOpen))
		}
	})
</script>

{#if page.url.pathname === '/proxy'}
	{@render children()}
{:else}
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

				{#if identity && account}
					<Horizontal
						--horizontal-gap="var(--half-padding)"
						--horizontal-align-items="center"
						onclick={() => (drawerOpen = true)}
						class="clickable"
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
			<Drawer bind:drawerOpen {account} {identities} {identityId} />
		{/if}
	</div>
{/if}

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
	:global(.clickable) {
		cursor: pointer;
	}
</style>
