<script lang="ts">
	import type { Snippet } from 'svelte'
	import type { HTMLAttributes } from 'svelte/elements'

	type Props = {
		children: Snippet
		class?: string
		reverse?: boolean
	}
	let {
		children,
		class: className = '',
		reverse = false,
		...restProps
	}: Props & HTMLAttributes<HTMLDivElement> = $props()
</script>

<div class="responsive {className}" class:reverse {...restProps}>
	{@render children()}
</div>

<style>
	:root {
		--responsive-gap: var(--padding);
		--responsive-justify-content: flex-start;
		--responsive-align-items: center;
	}
	.responsive {
		display: flex;
		flex-direction: row;
		justify-content: var(--responsive-justify-content);
		align-items: var(--responsive-align-items);
		gap: var(--responsive-gap);
	}
	.reverse {
		flex-direction: row-reverse;
	}
	@media screen and (max-width: 1023px) {
		.responsive {
			flex-direction: column;
			justify-content: var(--responsive-align-items);
			align-items: var(--responsive-justify-content);
		}
	}
</style>
