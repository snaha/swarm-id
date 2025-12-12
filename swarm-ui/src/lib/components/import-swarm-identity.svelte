<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Information from 'carbon-icons-svelte/lib/Information.svelte'
	import Upload from 'carbon-icons-svelte/lib/Upload.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'

	let showTooltip = $state(false)
</script>

<div class="import-row" role="button" tabindex="-1">
	<Horizontal --horizontal-justify-content="space-between">
		<Horizontal --horizontal-justify-content="start" --horizontal-gap="var(--half-padding)">
			<Button variant="ghost" dimension="small">
				<Upload size={16} />
				Import account
			</Button>
			<Tooltip show={showTooltip} position="top" variant="small" color="dark" maxWidth="360px">
				<Button
					variant="ghost"
					dimension="small"
					onmouseenter={() => (showTooltip = true)}
					onmouseleave={() => (showTooltip = false)}
					onclick={(e: MouseEvent) => {
						e.stopPropagation()
						showTooltip = !showTooltip
					}}
				>
					<Information size={16} />
				</Button>
				{#snippet helperText()}
					Import an existing Swarm ID account that was previously exported as a <span
						style="color: var(--colors-high)">.swarmid</span
					> file
				{/snippet}
			</Tooltip>
		</Horizontal>
		<div class="info-text">
			<Typography variant="small"
				>Visit <a href={window.location.origin}>{window.location.host}</a> for info about Swarm ID</Typography
			>
		</div>
	</Horizontal>
</div>

<style>
	.import-row {
		padding: var(--padding);
		cursor: pointer;
	}

	.info-text {
		display: flex;
		align-items: center;
		gap: 4px;
	}
</style>
