<script lang="ts">
	import Button from './ui/button.svelte'
	import Modal, { type ModalProps } from './ui/modal.svelte'
	import Typography from './ui/typography.svelte'
	import { Close } from 'carbon-icons-svelte'
	import LoaderButton from './loader-button.svelte'

	type Props = {
		confirm: () => void
		title: string
		text: string
		buttonTitle: string
	}
	let {
		oncancel,
		confirm,
		open = $bindable(false),
		title,
		text,
		buttonTitle,
		...restProps
	}: ModalProps & Props = $props()
</script>

<Modal {oncancel} bind:open {...restProps}>
	<section class="dialog">
		<header class="horizontal">
			<Typography variant="h5">{title}</Typography>
			<div class="grower"></div>
			<Button variant="ghost" dimension="compact" onclick={oncancel}><Close size={24} /></Button>
		</header>

		<Typography>{text}</Typography>
		<section class="buttons">
			<LoaderButton variant="strong" dimension="compact" onclick={confirm}
				>{buttonTitle}</LoaderButton
			>
			<Button variant="secondary" dimension="compact" onclick={oncancel}>Cancel</Button>
			<div class="grower"></div>
		</section>
	</section>
</Modal>

<style lang="postcss">
	.dialog {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: var(--padding);
		background-color: var(--colors-ultra-low);
		padding: var(--padding);
		height: 100%;
	}
	.horizontal {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--half-padding);
	}
	.buttons {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--half-padding);
	}
	@media screen and (max-width: 624px) {
		.buttons {
			flex-direction: column-reverse;
			align-items: stretch;
		}
	}
	.grower {
		flex-grow: 1;
	}
</style>
