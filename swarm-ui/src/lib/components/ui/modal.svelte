<script lang="ts" module>
	import { browser } from '$app/environment'
	import { onDestroy, onMount } from 'svelte'
	import type { HTMLDialogAttributes } from 'svelte/elements'

	export interface ModalProps extends HTMLDialogAttributes {
		oncancel?: () => void
		onshow?: () => void
		open?: boolean
	}
</script>

<script lang="ts">
	let {
		oncancel = () => {},
		onshow = () => {},
		open = $bindable(false),
		children,
	}: ModalProps = $props()

	let dialog: HTMLDialogElement | undefined = $state()
	let modalContent: HTMLDivElement | undefined = $state()

	let prevOpen = $state(open)

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as unknown as Node
		if (!modalContent?.contains(target)) {
			closeModal()
		}
	}

	function showModal() {
		setTimeout(() => {
			if (browser) {
				window.addEventListener('click', handleClickOutside)
			}
		})
		open = true
		dialog?.showModal()
		onshow()
	}

	function closeModal() {
		if (browser) {
			window.removeEventListener('click', handleClickOutside)
		}
		open = false
		dialog?.close()
		oncancel()
	}
	$effect(() => {
		if (prevOpen === open) {
			return
		}
		prevOpen = open
		if (open) {
			showModal()
		} else {
			closeModal()
		}
	})
	onMount(() => {
		if (open) {
			showModal()
		}
	})
	onDestroy(() => {
		if (browser) {
			window.removeEventListener('click', handleClickOutside)
		}
	})
</script>

<dialog bind:this={dialog} oncancel={closeModal}>
	<div bind:this={modalContent}>
		{#if children}
			{@render children()}
		{/if}
	</div>
</dialog>

<style>
	:root {
		--modal-max-width: 592px;
	}
	dialog {
		border: 0;
		background-color: var(--colors-ultra-low);
		padding: 0;
		max-width: var(--modal-max-width);
		width: 100%;
		color: var(--colors-ultra-high);
		border-radius: var(--quarter-padding);
	}
	@media screen and (max-width: 592px) {
		dialog {
			max-width: calc(100% - var(--double-padding));
			margin: auto var(--padding);
		}
	}
	::backdrop {
		background-color: var(--colors-dark-overlay);
	}
</style>
