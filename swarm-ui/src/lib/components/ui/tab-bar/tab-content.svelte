<script lang="ts">
	import { getContext, onMount, type Snippet } from 'svelte'
	import type { TabStore } from './tab-store.svelte'

	type Props = {
		value: string | Snippet
		children: Snippet
		id?: string | undefined
		disabled?: boolean
	}

	let { value = $bindable(), children, id, disabled = false }: Props = $props()

	const store = getContext<TabStore>('tab-store')
	let selected = $derived(store.items[store.selected] === value)

	onMount(() => {
		store.addItem(value, id, disabled)
	})

	// Reactively update disabled state when prop changes
	$effect(() => {
		store.updateDisabled(value, disabled)
	})
</script>

{#if selected}
	{#if children}
		{@render children()}
	{/if}
{/if}
