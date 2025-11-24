<script lang="ts">
	import type { Snippet } from 'svelte'
	import Button, { type Variant, type Dimension, type Mode } from '$lib/components/ui/button.svelte'

	type Props = {
		disabled?: boolean
		up?: boolean
		left?: boolean
		button: Snippet
		children: Snippet
		buttonVariant?: Variant
		buttonDimension?: Dimension
		autoClose?: boolean
		class?: string
		open?: boolean
		mode?: Mode
		stopPropagation?: boolean
	}

	let {
		disabled = false,
		up = false,
		left = false,
		button,
		children,
		buttonVariant = 'ghost',
		buttonDimension = 'default',
		autoClose = true,
		class: className,
		open = $bindable(false),
		mode = 'auto',
		stopPropagation = false,
	}: Props = $props()

	let dropdownElement: HTMLElement
	let dropdownMenu: HTMLElement
	let dropdownId: string = Math.random().toString(16).substring(10)

	const dropdownBottom = $derived(up ? `${buttonSize() + 2 + 4}px` : 'auto')

	function buttonSize() {
		return buttonDimension === 'small'
			? 32
			: buttonDimension === 'compact'
				? 40
				: buttonDimension === 'default'
					? 40
					: 48
	}

	function close(ev: MouseEvent) {
		const target = ev.target as unknown as Node
		if (dropdownElement.contains(target)) {
			// Clicked on the dropdown button or inside the dropdown
			if (dropdownMenu.contains(target) && autoClose) {
				open = false
			}
		} else {
			// Clicked outside the dropdown
			open = false
		}
	}

	function onKeyUp(ev: KeyboardEvent) {
		if (ev.key === 'Escape') {
			open = false
		}
	}

	$effect(() => {
		window.addEventListener('click', close)
		window.addEventListener('keyup', onKeyUp)

		return () => {
			window.removeEventListener('click', close)
			window.removeEventListener('keyup', onKeyUp)
		}
	})

	function onClick(e: Event) {
		if (!disabled) open = !open

		if (stopPropagation) {
			e.stopPropagation()
		}
		e.preventDefault()
	}

	function onKeyPress() {
		// omit keypress because onClick will be dispatched anyways
	}
</script>

<div
	bind:this={dropdownElement}
	class="dropdown"
	role="combobox"
	aria-haspopup="listbox"
	aria-expanded={open}
	aria-controls={dropdownId}
	tabindex={-1}
>
	<Button
		style="max-width:320px;"
		variant={buttonVariant}
		dimension={buttonDimension}
		{mode}
		active={open}
		onclick={onClick}
		onkeypress={onKeyPress}>{@render button()}</Button
	>

	<div class={`root`} aria-hidden={!open}>
		<div
			bind:this={dropdownMenu}
			class={className}
			class:hidden={!open}
			class:up
			class:left
			id={dropdownId}
			role="listbox"
			aria-labelledby="dropdown-button"
			tabindex={-1}
			style={`bottom: ${dropdownBottom}`}
		>
			{@render children()}
		</div>
	</div>
</div>

<style lang="postcss">
	.root {
		position: relative;

		div {
			position: absolute;
			z-index: 1000;
			backdrop-filter: blur(var(--blur));
			inset: calc(100% + var(--spacing-6)) 0 auto auto;
			box-shadow: 0 1px 5px 0 rgba(var(--color-accent-rgb, var(--color-dark-base-rgb)), 0.25);
			border-radius: var(--border-radius);
			width: max-content;
			max-width: 450px;

			&.hidden {
				display: none;
			}

			&.up {
				top: auto;
				right: 0;
				left: auto;
			}

			&.left {
				top: 4px;
				right: 0;
				left: auto;
			}
		}
	}
</style>
