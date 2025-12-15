<script lang="ts">
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
	import type { SelectStore } from './select-store.svelte'
	import type { HTMLButtonAttributes } from 'svelte/elements'

	interface Props extends HTMLButtonAttributes {
		value: string
		store: SelectStore
	}
	let { value, store, children, class: className = '', onclick, ...restProps }: Props = $props()

	// If onclick is provided, this is an action button (won't be registered for selection)
	const isAction = $derived(onclick !== undefined)

	let button = $state<HTMLButtonElement | undefined>()

	$effect(() => {
		if (!isAction) {
			store.registerValue(value, button?.innerText)
		}
	})
	let marked = $derived(store.marked === value)
	let selected = $derived(!isAction && store.value === value)
</script>

<button
	class="ghost {store.size} {className}"
	bind:this={button}
	onclick={onclick ??
		(() => {
			if (!store.open) return
			store.marked = value
			store.value = value
			store.changed = true
		})}
	onmouseenter={() => {
		store.marked = value
	}}
	class:selected
	class:marked
	tabindex="-1"
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		{value}
	{/if}
	{#if selected}
		<Checkmark size={store.size === 'small' ? 16 : 24} />
	{/if}
</button>

<style lang="postcss">
	button {
		display: inline-flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		border-radius: var(--border-radius);
		font-style: normal;
		font-weight: 400;
		font-family: var(--font-family-sans-serif);
		&:disabled {
			opacity: 0.25;
			cursor: not-allowed;
		}
	}
	.ghost {
		border: 1px solid transparent;
		background: transparent;
		color: var(--colors-ultra-high);
		&.marked:not(:disabled),
		&.marked:not(:disabled).selected:not(:disabled) {
			background: var(--colors-low);
		}
	}
	.default {
		padding: var(--three-quarters-padding);
		min-width: 3rem;
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.large {
		padding: var(--three-quarters-padding);
		min-width: 3.5rem;
		font-size: var(--font-size-large);
		line-height: var(--line-height-large);
		letter-spacing: var(--letter-spacing-large);
	}
	.compact {
		padding: var(--half-padding);
		min-width: 2.5rem;
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.small {
		gap: 0.25rem;
		padding: var(--half-padding);
		min-width: 2rem;
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
</style>
