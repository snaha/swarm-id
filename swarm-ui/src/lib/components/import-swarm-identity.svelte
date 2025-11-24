<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import BxInfoCircle from '$lib/components/boxicons/bx-info-circle.svelte'
	import BxUpload from '$lib/components/boxicons/bx-upload.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'

	interface Props {
		onclick?: () => void
	}

	let { onclick }: Props = $props()
	let isHovered = $state(false)
	let isFocused = $state(false)
	let showTooltip = $state(false)
</script>

<div
	class="import-row"
	role="button"
	tabindex="0"
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
	onfocus={() => (isFocused = true)}
	onblur={() => (isFocused = false)}
	{onclick}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			onclick?.()
		}
	}}
>
	<Horizontal --horizontal-justify-content="space-between">
		<div class="info-text">
			<Typography variant="small">Use an existing Swarm ID account</Typography>
			<Tooltip show={showTooltip} position="top" variant="compact" color="dark" maxWidth="360px">
				{#snippet children()}
					<Button
						variant="ghost"
						dimension="compact"
						onmouseenter={() => (showTooltip = true)}
						onmouseleave={() => (showTooltip = false)}
						onclick={(e: MouseEvent) => {
							e.stopPropagation()
							showTooltip = !showTooltip
						}}
					>
						<BxInfoCircle width={20} height={20} />
					</Button>
				{/snippet}
				{#snippet helperText()}
					Import an existing Swarm ID account that was previously exported as a <span
						style="color: var(--colors-high)">.swarmid</span
					> file
				{/snippet}
			</Tooltip>
		</div>
		<Button variant="ghost" dimension="compact" hover={isHovered || isFocused}>
			<BxUpload width={20} height={20} />
			Import from file
		</Button>
	</Horizontal>
</div>

<style>
	.import-row {
		border: 1px solid var(--colors-low);
		border-top: none;
		padding: var(--padding);
		background: var(--colors-card-bg);
		cursor: pointer;
	}

	.import-row:hover,
	.import-row:focus {
		background: var(--colors-base);
	}

	.import-row:focus {
		outline: var(--focus-outline);
		outline-offset: var(--focus-outline-offset);
	}

	.info-text {
		display: flex;
		align-items: center;
		gap: 4px;
	}
</style>
