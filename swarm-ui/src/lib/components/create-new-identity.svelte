<script lang="ts">
	import { page } from '$app/stores'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import AuthCard from '$lib/components/auth-card.svelte'
	import ImportSwarmIdentity from '$lib/components/import-swarm-identity.svelte'
	import Wallet from 'carbon-icons-svelte/lib/Wallet.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import { goto } from '$app/navigation'
	import routes from '$lib/routes'

	function handlePasskeyClick() {
		goto(routes.PASSKEY_NEW)
	}

	function handleEthClick() {
		goto(routes.ETH_NEW)
	}

	function handleImportClick() {
		console.log('Import from file')
	}
</script>

<Vertical --vertical-gap="var(--padding)" class="content-box">
	<Horizontal --horizontal-gap="0">
		<div class="card-wrapper card-left">
			<AuthCard
				title="Use Ethereum wallet"
				description="Create a Swarm ID account using your Ethereum wallet"
				buttonText="Sign up with Ethereum"
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
				description="Create a Swarm ID account on this device using a passkey"
				buttonText="Sign up with Passkey"
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
