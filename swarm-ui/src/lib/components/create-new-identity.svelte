<script lang="ts">
	import { page } from '$app/stores'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import AuthCard from '$lib/components/auth-card.svelte'
	import ImportSwarmIdentity from '$lib/components/import-swarm-identity.svelte'
	import { Wallet } from 'carbon-icons-svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import { goto } from '$app/navigation'
	import routes from '$lib/routes'

	// Get the origin parameter from the URL if it exists (we're in /connect route)
	const origin = $page.url.searchParams.get('origin')

	function handlePasskeyClick() {
		const url = origin
			? `${routes.PASSKEY_NEW}?origin=${encodeURIComponent(origin)}`
			: routes.PASSKEY_NEW
		goto(url)
	}

	function handleEthClick() {
		const url = origin ? `${routes.ETH_NEW}?origin=${encodeURIComponent(origin)}` : routes.ETH_NEW
		goto(url)
	}

	function handleImportClick() {
		console.log('Import from file')
	}
</script>

<Vertical --vertical-gap="0" class="content-box">
	<Horizontal --horizontal-gap="0">
		<div class="card-wrapper card-left">
			<AuthCard
				title="Use Ethereum"
				description="Connect an Ethereum wallet to create a new Swarm ID account"
				buttonText="Connect wallet"
				onclick={handleEthClick}
			>
				{#snippet icon()}
					<EthereumLogo fill="#242424" width={64} height={64} />
				{/snippet}
				{#snippet buttonIcon()}
					<Wallet size={20} />
				{/snippet}
			</AuthCard>
		</div>
		<div class="card-wrapper card-right">
			<AuthCard
				title="Use Passkey"
				description="Use Passkey on this device to create a new Swarm ID account"
				buttonText="Use Passkey"
				onclick={handlePasskeyClick}
			>
				{#snippet icon()}
					<PasskeyLogo fill="#242424" width={64} height={64} />
				{/snippet}
				{#snippet buttonIcon()}
					<PasskeyLogo fill="#FAFAFA" width={20} height={20} />
				{/snippet}
			</AuthCard>
		</div>
	</Horizontal>
	<ImportSwarmIdentity onclick={handleImportClick} />
</Vertical>

<style>
	.card-wrapper {
		flex: 1;
		border: 1px solid var(--colors-low);
	}

	.card-right {
		border-left: none;
	}
</style>
