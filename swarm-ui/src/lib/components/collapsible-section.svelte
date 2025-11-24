<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Badge from '$lib/components/ui/badge.svelte'
	import { ChevronDown, ChevronRight } from 'carbon-icons-svelte'
	import type { Snippet } from 'svelte'

	interface Props {
		title: string
		count?: number
		expanded?: boolean
		onToggle?: () => void
		children: Snippet
	}

	let { title, count, expanded = true, onToggle, children }: Props = $props()

	let isExpanded = $state(expanded)

	function handleToggle() {
		isExpanded = !isExpanded
		onToggle?.()
	}
</script>

<Vertical --vertical-gap="var(--half-padding)">
	<Horizontal
		--horizontal-gap="var(--half-padding)"
		--horizontal-align-items="center"
		--horizontal-justify-content="flex-start"
		onclick={handleToggle}
	>
		<Button variant="ghost" dimension="compact">
			{#if isExpanded}
				<ChevronDown size={16} />
			{:else}
				<ChevronRight size={16} />
			{/if}
		</Button>
		<Typography variant="h5">{title}</Typography>
		{#if count !== undefined}
			<Badge>{count}</Badge>
		{/if}
	</Horizontal>

	{#if isExpanded}
		{@render children()}
	{/if}
</Vertical>
