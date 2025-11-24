<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import BxX from '$lib/components/boxicons/bx-x.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import BxLeftArrowAlt from '$lib/components/boxicons/bx-left-arrow-alt.svelte'

	interface Props {
		title: string
		description: string
		onBack?: () => void
		onClose?: () => void
		content: import('svelte').Snippet
		buttonContent: import('svelte').Snippet
	}

	let { title, description, onBack, onClose, content, buttonContent }: Props = $props()
</script>

<Vertical --vertical-gap="var(--double-padding)">
	<Vertical --vertical-gap="var(--padding)">
		<Horizontal
			class="header"
			--horizontal-justify-content="space-between"
			--horizontal-align-items="center"
		>
			{#if onBack}
				<Horizontal --horizontal-gap="var(--half-padding)">
					<Button dimension="compact" variant="ghost" onclick={onBack}><BxLeftArrowAlt /></Button>
					<Typography variant="h4">{title}</Typography>
				</Horizontal>
			{:else}
				<Typography variant="h4">{title}</Typography>
			{/if}
			{#if onClose}
				<Button dimension="compact" variant="ghost" onclick={onClose}><BxX /></Button>
			{/if}
		</Horizontal>
		<Typography>{description}</Typography>
	</Vertical>
	{@render content()}
	<Horizontal>
		{@render buttonContent()}
	</Horizontal>
</Vertical>
