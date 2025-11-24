<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements'

	type Orientation = 'vertical' | 'horizontal'
	interface Props extends HTMLAttributes<HTMLHRElement> {
		orientation?: Orientation
	}
	let { orientation = 'horizontal', class: className = '', ...restProps }: Props = $props()
</script>

<hr class="{orientation} {className}" {...restProps} />

<style lang="postcss">
	.horizontal {
		margin-top: var(--margin, var(--padding));
		margin-bottom: var(--margin, var(--padding));
		width: 100%;
	}
	.vertical {
		margin-right: var(--margin, var(--padding));
		margin-left: var(--margin, var(--padding));
		min-width: 1px;
		height: 100%;
		min-height: var(--padding);
	}
	hr {
		appearance: none;
		border-width: 1px 1px 0 0;
		border-style: solid;
		color: var(--divider-color, var(--colors-low));
	}
</style>
