<script lang="ts">
	import { onMount, setContext, type Snippet } from 'svelte'
	import { withTabStore, type TabStore } from './tab-store.svelte'
	import Button from '$lib/components/ui/button.svelte'

	type Dimension = 'default' | 'large' | 'compact' | 'small'
	type Props = {
		dimension?: Dimension
		children: Snippet
		ulClass?: string
		liClass?: string
		buttonClass?: string
		controls?: Snippet
		selectedTabIndex?: number
		selectedTabId?: string
	}

	let {
		dimension = 'default',
		children,
		ulClass,
		liClass,
		buttonClass,
		controls,
		selectedTabIndex = $bindable(0),
		selectedTabId = $bindable(),
	}: Props = $props()

	const store = withTabStore()
	setContext<TabStore>('tab-store', store)

	function selectTab(i: number) {
		store.selected = i
		selectedTabIndex = i
		selectedTabId = store.ids[i]
	}

	$effect(() => {
		if (selectedTabId && selectedTabId !== store.ids[store.selected]) {
			selectTabById(selectedTabId)
		}
	})

	onMount(() => {
		if (typeof selectedTabIndex === 'number') {
			selectTab(selectedTabIndex)
		} else if (typeof selectedTabId === 'string') {
			selectTabById(selectedTabId)
		} else {
			selectTab(0)
		}
	})

	function selectTabById(selectedId: string) {
		const index = store.ids.findIndex((id) => id === selectedId)
		if (index >= 0) {
			selectTab(index)
		} else {
			selectTab(0)
		}
	}
</script>

<div class="tab-container">
	<ul class={ulClass}>
		{#each store.items as item, i}
			<li class={liClass}>
				{#if typeof item === 'string'}
					<Button
						class={buttonClass}
						variant="ghost"
						active={selectedTabIndex === i}
						{dimension}
						disabled={store.disabled[i]}
						onclick={() => selectTab(i)}>{item}</Button
					>
				{:else}
					<Button
						class={buttonClass}
						variant="ghost"
						active={selectedTabIndex === i}
						{dimension}
						disabled={store.disabled[i]}
						onclick={() => selectTab(i)}
					>
						{@render item()}
					</Button>
				{/if}
			</li>
		{/each}
		{#if controls}
			<div class="grower"></div>
			<div class="controls">
				{@render controls()}
			</div>
		{/if}
	</ul>

	<div class="tab-content">
		{#if children}
			{@render children()}
		{/if}
	</div>
</div>

<style>
	ul {
		display: flex;
		flex-direction: row;
		justify-content: flex-start;
		gap: 0;
		margin-top: 0px;
		margin-bottom: 0px;
		padding-left: unset;
		list-style: none;
		border: 1px solid var(--colors-low);
	}
	li {
		flex: 1;
		margin: 0;
		padding: 0;
	}
	li :global(button),
	li :global(a) {
		border-radius: 0;
		color: var(--colors-ultra-high);
		text-transform: uppercase;
		font-weight: 700;
		padding: var(--half-padding) !important;
		margin: 0;
	}
	li :global(.root) {
		margin: 0;
		padding: 0;
	}
	li :global(button.active),
	li :global(a.active),
	li :global(button.ghost.active),
	li :global(a.ghost.active),
	li :global(button.auto.active),
	li :global(a.auto.active) {
		background: var(--colors-low) !important;
		color: var(--colors-high) !important;
	}
	.tab-container {
		display: flex;
		flex-direction: column;
		width: 100%;
	}
	.tab-content {
		display: flex;
		flex-direction: column;
	}
	.grower {
		flex-grow: 1;
	}
	.controls {
		display: flex;
	}
</style>
