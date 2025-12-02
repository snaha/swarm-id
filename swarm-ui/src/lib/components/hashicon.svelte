<script lang="ts">
	import { onMount } from 'svelte'
	import { hashicon, type Params } from '@emeraldpay/hashicon'

	interface Props {
		value: string
		size?: number
		class?: string
		options?: Partial<Params>
	}

	let { value, size = 40, class: className, options }: Props = $props()

	let container: HTMLDivElement

	// Build hashicon options object
	const hashiconOptions = $derived({
		size,
		hue: options?.hue ?? { min: 0, max: 360 },
		saturation: options?.saturation ?? { min: 70, max: 90 },
		lightness: options?.lightness ?? { min: 45, max: 55 },
		variation: options?.variation ?? { min: 0, max: 1, enabled: true },
		shift: options?.shift ?? { min: 60, max: 240 },
		figureAlpha: options?.figureAlpha ?? { min: 0, max: 2 },
		light: options?.light ?? { top: 10, right: -8, left: -4, enabled: false },
	})

	onMount(() => {
		if (container && value) {
			// Clear previous icon if any
			container.innerHTML = ''
			// Generate and append the hashicon
			const icon = hashicon(value, hashiconOptions)
			container.appendChild(icon)
		}
	})

	$effect(() => {
		// Re-generate icon when value, size, or options change
		if (container && value) {
			container.innerHTML = ''
			const icon = hashicon(value, hashiconOptions)
			container.appendChild(icon)
		}
	})
</script>

<div bind:this={container} class="hashicon {className ?? ''}"></div>

<style>
	.hashicon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 0;
	}
</style>
