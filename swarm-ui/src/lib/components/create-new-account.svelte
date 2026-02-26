<script lang="ts">
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import AuthCard from '$lib/components/auth-card.svelte'
	import SignInCard from '$lib/components/sign-in-card.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import routes from '$lib/routes'
	import { layoutStore } from '$lib/stores/layout.svelte'
	import { notImplemented } from '$lib/utils/not-implemented'
	import type { Snippet } from 'svelte'

	interface Props {
		header?: Snippet
		showAgentSignup?: boolean
	}

	let { header, showAgentSignup = false }: Props = $props()

	function handlePasskeyClick() {
		goto(resolve(routes.PASSKEY_NEW))
	}

	function handleEthClick() {
		goto(resolve(routes.ETH_NEW))
	}

	function handleSignInClick(e: Event) {
		notImplemented(e)
	}
</script>

<Vertical --vertical-gap="0" class="wrapper">
	<Vertical --vertical-gap="0" --vertical-justify-content="center" class="center-area">
		{#if header}
			{@render header()}
		{/if}
		<div class="container">
			{#if layoutStore.mobile}
				<AuthCard
					title="Use Ethereum wallet"
					description="Create a Swarm ID account using your Ethereum wallet"
					buttonText="Sign up with Ethereum"
					onclick={handleEthClick}
				>
					{#snippet icon()}
						<EthereumLogo fill="var(--colors-ultra-high)" width={48} height={48} />
					{/snippet}
				</AuthCard>
				<AuthCard
					title="Use Passkey"
					description="Create a Swarm ID account on this device using a passkey"
					buttonText="Sign up with Passkey"
					onclick={handlePasskeyClick}
				>
					{#snippet icon()}
						<PasskeyLogo fill="var(--colors-ultra-high)" width={48} height={48} />
					{/snippet}
				</AuthCard>
				<SignInCard
					text="Already have a Swarm ID account?"
					buttonText="Sign in"
					onclick={handleSignInClick}
				/>
			{:else}
				<Horizontal --horizontal-gap="0">
					<div class="card-wrapper">
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
					<div class="card-wrapper">
						<AuthCard
							title="Sign up with Passkey"
							description="Create a Swarm ID account on this device using a Passkey"
							buttonText="Create Passkey account"
							onclick={handlePasskeyClick}
						>
							{#snippet icon()}
								<PasskeyLogo fill="var(--colors-ultra-high)" width={64} height={64} />
							{/snippet}
						</AuthCard>
					</div>
				</Horizontal>
				<SignInCard
					text="Already have a Swarm ID account?"
					buttonText="Sign in"
					onclick={handleSignInClick}
				/>
			{/if}
		</div>
	</Vertical>
	<div class="footer-text">
		<!-- eslint-disable svelte/no-navigation-without-resolve -- full URL, not a route -->
		<Typography variant="small">
			Visit <a href={window.location.origin}>{window.location.host}</a> for info about Swarm ID
		</Typography>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{#if showAgentSignup}
			<Typography variant="small">
				<a href={resolve(routes.AGENT_NEW)}>Sign up as agent</a>
			</Typography>
		{/if}
	</div>
</Vertical>

<style>
	.container {
		border: 1px solid var(--colors-low);
	}

	.card-wrapper {
		flex: 1;
	}

	.card-wrapper + .card-wrapper {
		border-left: 1px solid var(--colors-low);
	}

	.footer-text {
		padding-top: var(--padding);
	}

	.footer-text :global(a) {
		color: var(--colors-high);
	}

	@media screen and (max-width: 640px) {
		:global(.wrapper) {
			flex: 1;
		}

		:global(.center-area) {
			flex: 1;
		}

		.container {
			border: none;
			display: flex;
			flex-direction: column;
			margin-left: calc(-1 * var(--padding));
			margin-right: calc(-1 * var(--padding));
		}

		.container > :global(*) {
			border-top: 1px solid var(--colors-low);
		}

		.container > :global(*:last-child) {
			border-bottom: 1px solid var(--colors-low);
		}

		.footer-text {
			text-align: center;
			padding: var(--padding);
		}
	}
</style>
