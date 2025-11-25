<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import type { Snippet } from 'svelte'

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
	let isFocused = $state(false)
</script>

<div
	class="card"
	role="button"
	tabindex="0"
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
	onfocus={() => (isFocused = true)}
	onblur={() => (isFocused = false)}
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
	<Typography variant="h5">{title}</Typography>
	<Typography variant="small" center>
		{description}
	</Typography>
	<div class="button-wrapper">
		<Button variant="strong" dimension="compact" hover={isHovered || isFocused}>
			{#if buttonIcon}
				{@render buttonIcon()}
			{/if}
			{buttonText}
		</Button>
	</div>
</div>

<style>
	.card {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: var(--double-padding);
		background: var(--colors-card-bg);
		gap: var(--padding);
		cursor: pointer;
	}

	.card:hover,
	.card:focus {
		background: var(--colors-base);
	}

	.card:focus {
		outline: var(--focus-outline);
		outline-offset: var(--focus-outline-offset);
	}

	.icon {
		display: flex;
		justify-content: center;
		align-items: center;
		width: 52px;
		height: 52px;
	}

	.button-wrapper {
		margin-top: var(--padding);
	}
</style>
