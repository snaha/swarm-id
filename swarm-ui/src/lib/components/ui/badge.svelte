<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements'
	type Variant = 'default' | 'strong' | 'outline' | 'dark-overlay' | 'light-overlay' | 'error'
	type Dimension = 'small' | 'large'
	interface Props extends HTMLAttributes<HTMLDivElement> {
		variant?: Variant
		dimension?: Dimension
		class?: string
	}
	let {
		variant = 'default',
		dimension = 'small',
		children,
		class: className = '',
		...restProps
	}: Props = $props()
</script>

<div class="root {variant} {dimension} {className}" {...restProps}>
	{#if children}
		{@render children()}
	{/if}
</div>

<style lang="postcss">
	.root {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-family-sans-serif);
	}
	.small {
		border-radius: 0.75rem;
		padding: var(--quarter-padding) var(--half-padding);
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
	.large {
		border-radius: 1.25rem;
		padding: var(--half-padding) var(--three-quarters-padding);
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.default {
		background: var(--colors-low);
		color: var(--colors-ultra-high);
	}
	.strong {
		background: var(--colors-ultra-high);
		color: var(--colors-base);
	}
	.dark-overlay {
		background: var(--colors-dark-overlay);
		color: var(--colors-dark-top);
	}
	.light-overlay {
		background: var(--colors-light-overlay);
		color: var(--colors-light-ultra-high);
	}
	.error {
		background: var(--colors-red);
		color: white;
	}
</style>
