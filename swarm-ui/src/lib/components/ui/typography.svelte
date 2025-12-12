<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements'
	type Font = 'sans' | 'serif' | 'mono'
	type Variant = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'large' | 'default' | 'small'
	type Element = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span'
	interface CustomProps {
		variant?: Variant
		element?: Element
		font?: Font
		bold?: boolean
		italic?: boolean
		nowrap?: boolean
		lineThrough?: boolean
		center?: boolean
		accent?: boolean
	}
	type Props = (HTMLAttributes<HTMLHeadingElement> | HTMLAttributes<HTMLParagraphElement>) &
		CustomProps

	function getDefaultElement(variant: Variant) {
		switch (variant) {
			case 'h1':
				return 'h1'
			case 'h2':
				return 'h2'
			case 'h3':
				return 'h3'
			case 'h4':
				return 'h4'
			case 'h5':
				return 'h5'
			case 'h6':
				return 'h6'
			default:
				return 'span'
		}
	}

	let {
		variant = 'default',
		element,
		font = 'sans',
		bold = false,
		italic = false,
		nowrap = false,
		lineThrough = false,
		center = false,
		accent = false,
		class: className = '',
		children,
		...restProps
	}: Props = $props()

	// Compute element reactively - use const for $derived
	const computedElement = $derived(element ?? getDefaultElement(variant))
</script>

<svelte:element
	this={computedElement}
	class:bold
	class:italic
	class:nowrap
	class:line-through={lineThrough}
	class:center
	class:accent
	class={`root ${font} ${variant} ${className}`}
	{...restProps}
>
	{#if children}
		{@render children()}
	{/if}
</svelte:element>

<style>
	.root {
		margin: 0;
		padding: 0;
		color: var(--typography-color, var(--colors-ultra-high));
		font-style: normal;
		font-weight: 400;
	}
	.sans {
		font-family: var(--font-family-sans-serif);
	}
	.serif {
		font-family: var(--font-family-serif);
	}
	.mono {
		font-family: var(--font-family-monospace);
	}
	.bold {
		font-weight: 700;
	}
	.italic {
		font-style: italic;
	}
	.nowrap {
		white-space: nowrap;
		overflow-x: hidden;
		text-overflow: ellipsis;
	}
	.line-through {
		text-decoration: line-through;
	}
	.center {
		text-align: center;
	}
	.accent {
		color: var(--colors-high);
	}
	.h1 {
		font-weight: var(--font-weight-h1);
		font-size: var(--font-size-h1);
		line-height: var(--line-height-h1);
		font-family: var(--font-family-h1);
	}
	.h2 {
		font-weight: var(--font-weight-h2);
		font-size: var(--font-size-h2);
		line-height: var(--line-height-h2);
		font-family: var(--font-family-h2);
	}
	.h3 {
		font-weight: var(--font-weight-h3);
		font-size: var(--font-size-h3);
		line-height: var(--line-height-h3);
		font-family: var(--font-family-h3);
	}
	.h4 {
		font-weight: var(--font-weight-h4);
		font-size: var(--font-size-h4);
		line-height: var(--line-height-h4);
		font-family: var(--font-family-h4);
		letter-spacing: var(--letter-spacing-h4);
	}
	.h5 {
		font-weight: var(--font-weight-h5);
		font-size: var(--font-size-h5);
		line-height: var(--line-height-h5);
		font-family: var(--font-family-h5);
		letter-spacing: var(--letter-spacing-h5);
	}
	.h6 {
		font-weight: var(--font-weight-h6);
		font-size: var(--font-size-h6);
		line-height: var(--line-height-h6);
		font-family: var(--font-family-h6);
		letter-spacing: var(--letter-spacing-h6);
	}
	.large {
		font-size: var(--font-size-large);
		line-height: var(--line-height-large);
		letter-spacing: var(--letter-spacing-large);
	}
	.default {
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.small {
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
</style>
