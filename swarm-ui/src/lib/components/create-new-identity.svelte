<script lang="ts">
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import AuthCard from '$lib/components/auth-card.svelte'
	import ImportSwarmIdentity from '$lib/components/import-swarm-identity.svelte'
	import BxWallet from '$lib/components/boxicons/bx-wallet.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import { goto } from '$app/navigation'
	import routes from '$lib/routes'
</script>

<Vertical --vertical-gap="0" class="content-box">
	<Horizontal --horizontal-gap="0">
		<div class="card-wrapper card-left">
			<AuthCard
				title="Use Ethereum"
				description="Connect an Ethereum wallet to create a new Swarm ID account"
				buttonText="Connect wallet"
				onclick={() => goto(routes.ETH_NEW)}
			>
				{#snippet icon()}
					<EthereumLogo fill="#242424" width={64} height={64} />
				{/snippet}
				{#snippet buttonIcon()}
					<BxWallet width={20} height={20} />
				{/snippet}
			</AuthCard>
		</div>
		<div class="card-wrapper card-right">
			<AuthCard
				title="Use Passkey"
				description="Use Passkey on this device to create a new Swarm ID account"
				buttonText="Use Passkey"
				onclick={() => goto(routes.PASSKEY_NEW)}
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
	<ImportSwarmIdentity onclick={() => console.log('Import from file')} />
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
