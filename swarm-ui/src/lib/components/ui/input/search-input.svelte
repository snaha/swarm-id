<script lang="ts">
	import { Search } from 'carbon-icons-svelte'
	import Input, { type Props } from './input.svelte'
	import type { HTMLInputAttributes } from 'svelte/elements'

	let {
		value = $bindable(),
		variant = 'outline',
		dimension,
		disabled,
		...restProps
	}: Props & Omit<HTMLInputAttributes, 'type'> = $props()
	let size: 16 | 24 | 32 = $derived(dimension === 'large' ? 32 : dimension === 'small' ? 16 : 24)
</script>

{#snippet iconStart()}
	<Search {size} />
{/snippet}

<Input {dimension} {disabled} {iconStart} bind:value {variant} {...restProps} type="search" />
