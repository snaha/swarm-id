<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import type { Snippet } from 'svelte'
	import Vertical from './ui/vertical.svelte'

	interface Props {
		icon: Snippet
		title: string
		description: string
		buttonText: string
		buttonIcon?: Snippet
		onclick?: () => void
	}

	let { icon, title, description, buttonText, buttonIcon, onclick }: Props = $props()
	let isHovered = $state(false)
</script>

<div
	class="card"
	role="button"
	tabindex="-1"
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
	{onclick}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			onclick?.()
		}
	}}
>
	<div class="icon">
		{@render icon()}
	</div>
	<Vertical --vertical-gap="var(--quarter-padding)" --vertical-align-items="center">
		<Typography variant="h5">{title}</Typography>
		<Typography variant="small" center>
			{description}
		</Typography>
	</Vertical>
	<Button variant="strong" dimension="compact" hover={isHovered}>
		{#if buttonIcon}
			{@render buttonIcon()}
		{/if}
		{buttonText}
	</Button>
</div>

<style>
	.card {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: var(--padding);
		background: var(--colors-card-bg);
		gap: var(--padding);
		cursor: pointer;
	}

	.card:hover,
	.card:focus {
		background: var(--colors-base);
	}

	.icon {
		display: flex;
		justify-content: center;
		align-items: center;
		width: 64px;
		height: 64px;
	}
</style>
