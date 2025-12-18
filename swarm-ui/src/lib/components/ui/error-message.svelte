<script lang="ts">
	import WarningAltFilled from 'carbon-icons-svelte/lib/WarningAltFilled.svelte'
	import type { Snippet } from 'svelte'

	interface Props {
		children: Snippet
	}

	let { children }: Props = $props()
</script>

<div class="error-message">
	<WarningAltFilled width={20} height={20} />
	<span>{@render children()}</span>
</div>

<style>
	.error-message {
		display: flex;
		align-items: center;
		gap: 4px;
		border-radius: var(--border-radius);
		background: var(--colors-red);
		padding: var(--half-padding);
		color: var(--colors-base);
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
		font-weight: normal;
	}

	.error-message :global(svg) {
		flex-shrink: 0;
	}
</style>
