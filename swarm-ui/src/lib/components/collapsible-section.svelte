<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Badge from '$lib/components/ui/badge.svelte'
	import ChevronDown from 'carbon-icons-svelte/lib/ChevronDown.svelte'
	import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte'
	import type { Snippet } from 'svelte'

	interface Props {
		title: string
		subtitle?: string
		count?: string | number
		expanded?: boolean
		onToggle?: () => void
		children: Snippet
	}

	let { title, subtitle, count, expanded = true, onToggle, children }: Props = $props()

	// expanded prop is static in practice, internal state handles toggling
	// svelte-ignore state_referenced_locally
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
		<Vertical --vertical-gap="0">
			<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
				<Typography variant="h5">{title}</Typography>
				{#if count !== undefined}
					<Badge>{count}</Badge>
				{/if}
			</Horizontal>
			{#if subtitle}
				<Typography variant="small">{subtitle}</Typography>
			{/if}
		</Vertical>
	</Horizontal>

	{#if isExpanded}
		{@render children()}
	{/if}
</Vertical>
