<script lang="ts">
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import AuthCard from '$lib/components/auth-card.svelte'
	import ImportSwarmIdentity from '$lib/components/import-swarm-identity.svelte'
	import Wallet from 'carbon-icons-svelte/lib/Wallet.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import routes from '$lib/routes'

	function handlePasskeyClick() {
		goto(resolve(routes.PASSKEY_NEW))
	}

	function handleEthClick() {
		goto(resolve(routes.ETH_NEW))
	}

	function handleImportClick() {
		console.log('Import from file')
	}
</script>

<Vertical --vertical-gap="var(--padding)" class="content-box">
	<Horizontal --horizontal-gap="0">
		<div class="card-wrapper card-left">
			<AuthCard
				title="Sign up with Ethereum"
				description="Create a Swarm ID account using your Ethereum wallet"
				buttonText="Create Ethereum account"
				onclick={handleEthClick}
			>
				{#snippet icon()}
					<EthereumLogo fill="var(--colors-ultra-high)" width={64} height={64} />
				{/snippet}
			</AuthCard>
		</div>
		<div class="card-wrapper card-right">
			<AuthCard
				title="Sign up with Passkey"
				description="Create a Swarm ID account on this device using a Passkey"
				buttonText="Create Passkey account"
				onclick={handlePasskeyClick}
			>
				{#snippet icon()}
					<PasskeyLogo fill="var(--colors-ultra-high)" width={64} height={64} />
				{/snippet}
				{#snippet buttonIcon()}
					<PasskeyLogo fill="currentColor" width={20} height={20} />
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
