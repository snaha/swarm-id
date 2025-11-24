<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Badge from '$lib/components/ui/badge.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { ArrowRight } from 'carbon-icons-svelte'
	import type { Identity } from '$lib/types'

	interface Props {
		identities: Identity[]
		currentIdentityId?: string
		onIdentityClick?: (identity: Identity) => void
	}

	let { identities, currentIdentityId, onIdentityClick }: Props = $props()

	let hoveredIndex = $state<number | undefined>(undefined)
	let focusedIndex = $state<number | undefined>(undefined)

	function getAccount(accountId: string) {
		return accountsStore.getAccount(accountId)
	}

	function handleIdentityClick(identity: Identity) {
		if (identity.id === currentIdentityId) return
		onIdentityClick?.(identity)
	}
</script>

<Vertical --vertical-gap="0" style="border: 1px solid var(--colors-low);">
	{#each identities as identity, index}
		{@const account = getAccount(identity.accountId)}
		{#if account}
			<div
				class="identity-item"
				class:active={identity.id === currentIdentityId}
				role="button"
				tabindex="0"
				onmouseenter={() => (hoveredIndex = index)}
				onmouseleave={() => (hoveredIndex = undefined)}
				onfocus={() => (focusedIndex = index)}
				onblur={() => (focusedIndex = undefined)}
				onclick={() => handleIdentityClick(identity)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						handleIdentityClick(identity)
					}
				}}
			>
				<Horizontal
					--horizontal-gap="var(--half-padding)"
					--horizontal-align-items="center"
					--horizontal-justify-content="space-between"
				>
					<Hashicon value={identity.id} size={40} />
					<Vertical --vertical-gap="var(--quarter-padding)" style="flex: 1;">
						<Horizontal
							style="opacity: 0.5"
							--horizontal-gap="var(--quarter-padding)"
							--horizontal-align-items="center"
							--horizontal-justify-content="flex-start"
						>
							{#if account.type === 'passkey'}
								<PasskeyLogo fill="var(--colors-ultra-high)" width={20} height={20} />
							{:else if account.type === 'ethereum'}
								<EthereumLogo fill="var(--colors-ultra-high)" width={20} height={20} />
							{/if}
							<Typography variant="small">{account.name}</Typography>
						</Horizontal>
						<Typography>
							{identity.name}
						</Typography>
					</Vertical>
					{#if identity.id === currentIdentityId}
						<Badge>Current</Badge>
					{:else}
						<Button
							variant="ghost"
							dimension="compact"
							hover={hoveredIndex === index || focusedIndex === index}
						>
							<ArrowRight />
						</Button>
					{/if}
				</Horizontal>
			</div>
		{/if}
	{/each}
</Vertical>

<style>
	.identity-item {
		padding: var(--half-padding);
		border-bottom: 1px solid var(--Low, #e7e7e7);
		background: var(--colors-card-bg);
		cursor: pointer;
	}

	.identity-item:hover:not(.active),
	.identity-item:focus:not(.active) {
		background: var(--colors-base);
	}

	.identity-item.active {
		background: var(--colors-ultra-low);
		pointer-events: none;
	}

	.identity-item:focus {
		outline: var(--focus-outline);
		outline-offset: var(--focus-outline-offset);
	}

	.identity-item:last-child {
		border-bottom: none;
	}
</style>
