<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import type { ConnectedApp } from '$lib/types'

	interface Props {
		apps: ConnectedApp[]
		onAppClick?: (app: ConnectedApp) => void
	}

	let { apps, onAppClick }: Props = $props()

	let hoveredIndex = $state<number | undefined>(undefined)
	let focusedIndex = $state<number | undefined>(undefined)

	function handleAppClick(app: ConnectedApp) {
		onAppClick?.(app)
	}
</script>

<Vertical --vertical-gap="0" style="border: 1px solid var(--colors-low);">
	{#each apps as app, index}
		<div
			class="app-item"
			role="button"
			tabindex="0"
			onmouseenter={() => (hoveredIndex = index)}
			onmouseleave={() => (hoveredIndex = undefined)}
			onfocus={() => (focusedIndex = index)}
			onblur={() => (focusedIndex = undefined)}
			onclick={() => handleAppClick(app)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					handleAppClick(app)
				}
			}}
		>
			<Horizontal
				--horizontal-gap="var(--half-padding)"
				--horizontal-align-items="center"
				--horizontal-justify-content="space-between"
			>
				{#if app.favicon}
					<img src={app.favicon} alt={app.appName} class="app-favicon" />
				{:else}
					<div class="app-favicon-placeholder">{app.appName.charAt(0).toUpperCase()}</div>
				{/if}
				<Vertical --vertical-gap="var(--quarter-padding)" style="flex: 1;">
					<Typography>
						{app.appName}
					</Typography>
					<Typography variant="small" style="opacity: 0.5;">
						{app.appUrl}
					</Typography>
				</Vertical>
				<Button
					variant="ghost"
					dimension="compact"
					hover={hoveredIndex === index || focusedIndex === index}
				>
					<ArrowRight />
				</Button>
			</Horizontal>
		</div>
	{/each}
</Vertical>

<style>
	.app-item {
		padding: var(--half-padding);
		border-bottom: 1px solid var(--colors-low);
		background: var(--colors-card-bg);
		cursor: pointer;
	}

	.app-item:hover,
	.app-item:focus {
		background: var(--colors-base);
	}

	.app-item:focus {
		outline: var(--focus-outline);
		outline-offset: var(--focus-outline-offset);
	}

	.app-item:last-child {
		border-bottom: none;
	}

	.app-favicon {
		width: 40px;
		height: 40px;
		border-radius: 8px;
		object-fit: cover;
	}

	.app-favicon-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 8px;
		background: var(--colors-low);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		color: var(--colors-ultra-high);
	}
</style>
