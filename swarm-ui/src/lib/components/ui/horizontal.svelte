<script lang="ts">
	import type { Snippet } from 'svelte'
	import type { HTMLAttributes } from 'svelte/elements'

	type Props = {
		children: Snippet
	}
	let {
		children,
		class: className = '',
		...restProps
	}: Props & HTMLAttributes<HTMLDivElement> = $props()
</script>

<div class="horizontal {className}" {...restProps}>
	{#if children}
		{@render children()}
	{/if}
</div>

<style>
	:root {
		--horizontal-gap: var(--padding);
		--horizontal-justify-content: flex-start;
		--horizontal-align-items: center;
		--padding-left: unset;
	}
	.horizontal {
		display: flex;
		flex-direction: row;
		justify-content: var(--horizontal-justify-content);
		align-items: var(--horizontal-align-items);
		gap: var(--horizontal-gap);
		padding-left: var(--padding-left);
	}
</style>
