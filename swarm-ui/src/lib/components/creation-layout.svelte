<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import ArrowLeft from 'carbon-icons-svelte/lib/ArrowLeft.svelte'
	import { CloseLarge } from 'carbon-icons-svelte'
	import type { Snippet } from 'svelte'

	interface Props {
		title: string
		description?: string
		onBack?: () => void
		onClose?: () => void
		content: Snippet
		buttonContent: Snippet
	}

	let { title, description, onBack, onClose, content, buttonContent }: Props = $props()
</script>

<div class="layout">
	<div class="header">
		<Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
			{#if onBack}
				<Horizontal --horizontal-gap="var(--half-padding)">
					<Button dimension="compact" variant="ghost" onclick={onBack}><ArrowLeft /></Button>
					<Typography variant="h4">{title}</Typography>
				</Horizontal>
			{:else}
				<Typography variant="h4">{title}</Typography>
			{/if}
			{#if onClose}
				<Button dimension="compact" variant="ghost" onclick={onClose}
					><CloseLarge size={20} /></Button
				>
			{/if}
		</Horizontal>
		{#if description}
			<Typography>{description}</Typography>
		{/if}
	</div>
	<div class="content">
		{@render content()}
	</div>
	<div class="footer">
		{@render buttonContent()}
	</div>
</div>

<style>
	.layout {
		display: flex;
		flex-direction: column;
		gap: var(--double-padding);
		max-width: 560px;
		width: 100%;
		margin: auto;
		padding: var(--double-padding);
	}

	.header {
		display: flex;
		flex-direction: column;
		gap: var(--three-quarters-padding);
	}

	.footer {
		display: flex;
	}

	@media screen and (max-width: 640px) {
		.layout {
			flex: 1;
			gap: 0;
			max-width: none;
			margin: 0;
			padding: 0;
		}

		.header {
			padding: var(--padding);
			gap: var(--half-padding);
		}

		.content {
			flex: 1;
			display: flex;
			flex-direction: column;
			justify-content: center;
			padding: 0 var(--padding);
		}

		.footer {
			padding: var(--padding);
		}
	}
</style>
