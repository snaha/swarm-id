<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements'
	type Dimension = 'default' | 'large' | 'compact' | 'small'
	type Color = 'high' | 'low'
	type Props = {
		dimension?: Dimension
		color?: Color
	}
	let { dimension = 'default', color = 'low' }: Props & HTMLAttributes<HTMLDivElement> = $props()

	let size = dimensionToSize(dimension)

	function dimensionToSize(dimension: Dimension): number {
		switch (dimension) {
			case 'large':
				return 32
			case 'default':
				return 24
			case 'compact':
				return 24
			case 'small':
				return 16
		}
	}
</script>

<div
	class="loader"
	style="width: {size}px"
	class:high={color === 'high'}
	class:low={color === 'low'}
></div>

<style lang="postcss">
	.loader {
		width: 50px;
		padding: 2px;
		aspect-ratio: 1;
		border-radius: 50%;
		mask:
			conic-gradient(#0000 10%, #000),
			linear-gradient(#000 0 0) content-box;
		-webkit-mask-composite: source-out;
		mask-composite: subtract;
		animation: l3 1s infinite linear;
	}
	@keyframes l3 {
		to {
			transform: rotate(1turn);
		}
	}

	.high {
		background: var(--colors-base);
	}
	.low {
		background: var(--colors-ultra-high);
	}
</style>
