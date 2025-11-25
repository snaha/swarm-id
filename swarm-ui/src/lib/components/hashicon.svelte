<script lang="ts">
	import { onMount } from 'svelte'
	import { hashicon } from '@emeraldpay/hashicon'

	interface Props {
		value: string
		size?: number
		class?: string
	}

	let { value, size = 40, class: className }: Props = $props()

	let container: HTMLDivElement

	onMount(() => {
		if (container && value) {
			// Clear previous icon if any
			container.innerHTML = ''
			// Generate and append the hashicon
			const icon = hashicon(value, size)
			container.appendChild(icon)
		}
	})

	$effect(() => {
		// Re-generate icon when value or size changes
		if (container && value) {
			container.innerHTML = ''
			const icon = hashicon(value, size)
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
