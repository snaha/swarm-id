<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Hashicon from '$lib/components/hashicon.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import type { Identity } from '$lib/types'
	import FlexItem from './ui/flex-item.svelte'
	import { Checkmark } from 'carbon-icons-svelte'

	interface Props {
		identities: Identity[]
		currentIdentityId?: string
		onIdentityClick?: (identity: Identity) => void
		showBorder?: boolean
		showArrow?: boolean
	}

	let {
		identities,
		currentIdentityId,
		onIdentityClick,
		showBorder = true,
		showArrow = true,
	}: Props = $props()

	let hoveredIndex = $state<number | undefined>(undefined)
	let focusedIndex = $state<number | undefined>(undefined)

	function getAccount(accountId: Parameters<typeof accountsStore.getAccount>[0]) {
		return accountsStore.getAccount(accountId)
	}

	function handleIdentityClick(identity: Identity) {
		if (identity.id === currentIdentityId) return
		onIdentityClick?.(identity)
	}
</script>

<Vertical
	--vertical-gap="0"
	style={showBorder
		? 'border: 1px solid var(--colors-low); gap: 1px; background-color: var(--colors-low);'
		: ''}
>
	{#each identities as identity, index (identity.id)}
		{@const account = getAccount(identity.accountId)}
		{#if account}
			<Button
				variant="ghost"
				dimension="compact"
				onclick={() => handleIdentityClick(identity)}
				class={showBorder ? 'identity-button' : ''}
			>
				<Horizontal
					--horizontal-gap="var(--half-padding)"
					--horizontal-align-items="center"
					--horizontal-justify-content="stretch"
					style="flex: 1"
				>
					<Hashicon value={identity.id} size={40} />
					<Vertical --vertical-gap="0" --vertical-align-items="start" style="flex: 1;">
						<Typography variant="small">{account.name}</Typography>
						<Typography>
							{identity.name}
						</Typography>
					</Vertical>
					<FlexItem />
					{#if identity.id === currentIdentityId}
						<Checkmark size={20} />
					{:else if showArrow}
						<Button
							variant="ghost"
							dimension="compact"
							hover={hoveredIndex === index || focusedIndex === index}
						>
							<ArrowRight />
						</Button>
					{/if}
				</Horizontal>
			</Button>
		{/if}
	{/each}
</Vertical>

<style>
	:global(.identity-button) {
		background-color: var(--colors-ultra-low);
	}
</style>
