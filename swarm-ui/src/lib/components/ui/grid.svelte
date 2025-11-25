<script lang="ts">
	import type { Snippet } from 'svelte'

	interface Props {
		children: Snippet
		class?: string
		'--grid-template-columns'?: string
		'--grid-gap'?: string
		'--grid-align-items'?: string
		[key: string]: unknown
	}

	let {
		children,
		class: className,
		'--grid-template-columns': gridTemplateColumns = '1fr 1fr',
		'--grid-gap': gridGap = 'var(--padding)',
		'--grid-align-items': gridAlignItems = 'center',
		...restProps
	}: Props = $props()
</script>

<div
	class="grid {className ?? ''}"
	style:--grid-template-columns={gridTemplateColumns}
	style:--grid-gap={gridGap}
	style:--grid-align-items={gridAlignItems}
	{...restProps}
>
	{@render children()}
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: var(--grid-template-columns);
		gap: var(--grid-gap);
		align-items: var(--grid-align-items);
	}
</style>
