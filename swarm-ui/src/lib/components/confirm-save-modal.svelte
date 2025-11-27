<script lang="ts">
	import Modal from '$lib/components/ui/modal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'

	interface Props {
		open?: boolean
		onConfirm?: () => void
	}

	let { open = $bindable(false), onConfirm }: Props = $props()

	function handleConfirm() {
		onConfirm?.()
		open = false
	}
</script>

<Modal bind:open>
	<Vertical
		--vertical-gap="var(--one-and-half-padding)"
		style="padding: var(--padding)"
		tabindex={-1}
	>
		<Typography variant="h5">Confirm saving</Typography>
		<Vertical --vertical-gap="var(--padding)">
			<Typography>Have you saved your secret seed?</Typography>
			<Horizontal --horizontal-gap="var(--half-padding)">
				<Button dimension="compact" onclick={handleConfirm}>Yes I saved it</Button>
				<Button dimension="compact" variant="ghost" onclick={() => (open = false)}>Nope</Button>
			</Horizontal>
		</Vertical>
	</Vertical>
</Modal>
