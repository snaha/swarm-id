<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements'
	import CaretDown from 'carbon-icons-svelte/lib/CaretDown.svelte'
	import CaretUp from 'carbon-icons-svelte/lib/CaretUp.svelte'
	import { type Snippet } from 'svelte'
	import { withSelectStore } from './select-store.svelte'
	import Option from './option.svelte'

	type Layout = 'vertical' | 'horizontal'
	type Dimension = 'default' | 'large' | 'compact' | 'small'
	type Variant = 'outline' | 'solid'
	type Item = {
		value: string
		label: string
	}
	interface Props extends HTMLInputAttributes {
		helperText?: Snippet
		label?: string
		labelFor?: string
		dimension?: Dimension
		value?: string
		layout?: Layout
		hover?: boolean
		active?: boolean
		focus?: boolean
		variant?: Variant
		items: Item[]
	}
	let {
		helperText,
		label,
		labelFor = Math.random().toString(16),
		dimension = 'default',
		placeholder,
		value = $bindable(),
		layout = 'vertical',
		hover,
		active,
		focus,
		class: className = '',
		variant = 'outline',
		onchange = $bindable(),
		items,
		...restProps
	}: Props = $props()

	let input: HTMLInputElement | undefined = $state(undefined)
	let focused = $state(false)

	const store = withSelectStore(dimension, value ?? (placeholder ? '' : undefined))

	// Focused input when user clicks on caret,Unfocused input when user clicks outside input or caret
	// Close the select when user clicks outside, when user clicks on the tab button
	$effect(() => {
		function closeMenu() {
			if (store.open) store.open = false
		}

		function closeMenuKeyboard(e: KeyboardEvent) {
			if (e.key === 'Tab') closeMenu()
		}

		window.addEventListener('click', closeMenu)
		window.addEventListener('keydown', closeMenuKeyboard)

		return () => {
			window.removeEventListener('click', closeMenu)
			window.removeEventListener('keydown', closeMenuKeyboard)
		}
	})

	// Update store dimension if the dimension dynamically changes
	$effect(() => {
		store.size = dimension
	})

	// Bind store value to the value prop
	$effect(() => {
		if (value !== store.value) {
			if (store.changed) {
				value = store.value
				store.changed = false
				if (onchange && input) {
					onchange({ ...new Event('onchange'), currentTarget: input })
				}
			} else {
				store.value = value
			}
		}
	})
	$effect(() => {
		if (!store.open && store.value === undefined) {
			store.marked = undefined
		} else {
			store.marked = store.value
		}
	})
	$effect(() => {
		let lastTabInteraction = false
		const keyDown = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === 'tab') {
				lastTabInteraction = true
			}
		}

		function addFocus() {
			if (lastTabInteraction) {
				focused = true
			}
		}

		function removeFocus() {
			lastTabInteraction = false
			focused = false
		}

		window.addEventListener('keydown', keyDown)
		window.addEventListener('mousedown', removeFocus)
		input?.addEventListener('blur', removeFocus)
		input?.addEventListener('focus', addFocus)

		return () => {
			window.removeEventListener('keydown', keyDown)
			window.removeEventListener('mousedown', removeFocus)
			input?.removeEventListener('blur', removeFocus)
			input?.removeEventListener('focus', addFocus)
		}
	})
</script>

<div class="root {dimension} {layout} {className}">
	{#if label}
		<label class="label" for={labelFor}>
			{label}
		</label>
	{/if}
	<div class="select-container">
		<input
			bind:this={input}
			value={store.value ? (store.labels[store.value] ?? store.value) : value}
			class="select {variant}"
			class:hover
			class:active
			class:focus
			class:focused
			class:open={store.open}
			onclick={() => {
				if (!store.open)
					setTimeout(() => {
						store.open = true
					})
			}}
			onkeydown={(e) => {
				switch (e.key) {
					case 'ArrowDown': {
						e.preventDefault()
						if (!store.open) {
							store.open = true
						} else {
							const values = Object.keys(store.labels)
							const index = store.marked ? values.indexOf(store.marked) : -1
							store.marked = values[(index + 1) % values.length]
						}
						break
					}
					case 'ArrowUp': {
						e.preventDefault()
						if (!store.open) {
							store.open = true
						} else {
							const values = Object.keys(store.labels)
							const index = store.marked ? values.indexOf(store.marked) : 0
							if (index - 1 >= 0) store.marked = values[index - 1]
							else store.marked = values[values.length - 1]
						}
						break
					}
					case 'Enter': {
						e.preventDefault()
						if (!store.open) {
							store.open = true
						} else {
							store.value = store.marked
							store.open = false
						}
						break
					}
					case 'Escape': {
						if (store.open) {
							e.preventDefault()
							store.open = false
						}
					}
				}
			}}
			id={labelFor}
			{placeholder}
			readonly
			{...restProps}
		/>
		<div class="wrapper">
			<button
				class="icon"
				onclick={() => {
					if (!store.open) setTimeout(() => (store.open = true))
				}}
				tabindex="-1"
			>
				<div>
					{#if store.open}
						<CaretUp size={dimension === 'small' ? 16 : 24} />
					{:else}
						<CaretDown size={dimension === 'small' ? 16 : 24} />
					{/if}
				</div>
			</button>
			<div class="options" class:hidden={!store.open}>
				<div>
					{#if placeholder}
						<Option class="placeholder" value="" {store}>{placeholder}</Option>
					{/if}
					{#each items as item (item.value)}
						<Option value={item.value} {store}>{item.label}</Option>
					{/each}
				</div>
			</div>
		</div>
	</div>
	{#if helperText && layout === 'vertical'}
		<div class="helper-text">
			{@render helperText()}
		</div>
	{/if}
</div>

<style lang="postcss">
	.vertical {
		flex-direction: column;
		align-items: stretch;
	}
	.horizontal {
		flex-direction: row;
		align-items: center;
	}
	.root {
		--transition-delay: 50ms;
		--transition: 0;
		display: flex;
		flex-grow: 1;
		justify-content: center;
		gap: 0.5rem;
		color: var(--colors-ultra-high);
		font-family: var(--font-family-sans-serif);
		.select-container {
			display: flex;
			flex-grow: 1;
			flex-direction: column;
			&:has(.icon:hover) {
				.select:not(:disabled):not(.open):not(.focused) {
					border: 1px solid var(--colors-top);
					background: var(--colors-low);
					color: var(--colors-top);
					& + .wrapper > button {
						color: var(--colors-top);
					}
				}
			}
		}
	}
	input::selection {
		background-color: transparent;
	}
	.select {
		flex-grow: 1;
		appearance: none;
		cursor: pointer;
		border-radius: var(--border-radius);
		color: var(--colors-ultra-high);
		caret-color: transparent;
		font-family: inherit;
		&.outline {
			border: 1px solid var(--colors-ultra-high);
			background: transparent;
		}
		&.solid {
			border: 1px solid var(--colors-low);
			background: var(--colors-base);
		}
		&::placeholder {
			opacity: 0.5;
			color: var(--colors-ultra-high);
		}
		&:hover:not(:disabled),
		&:hover:not(:disabled),
		&.hover:not(:disabled) {
			border: 1px solid var(--colors-top);
			background: var(--colors-low);
			color: var(--colors-top);
			& + .wrapper > button {
				color: var(--colors-top);
			}
		}
		&:active:not(:disabled),
		&.active:not(:disabled),
		&.open:not(:disabled):not(.focused) {
			outline: none;
			border: 1px solid var(--colors-high);
			background: var(--colors-low);
			color: var(--colors-high);
			& + .wrapper > button {
				color: var(--colors-high);
			}
		}
		&:focus {
			outline: none;
		}
		&.focus:not(:disabled),
		&.focused:not(:disabled) {
			outline: var(--focus-outline);
			outline-offset: var(--focus-outline-offset);
			background: var(--colors-base);
			color: var(--colors-top);
			& + .wrapper > button {
				color: var(--colors-top);
			}
		}
		&.focused.open:not(:disabled) {
			border: 1px var(--colors-top);
			background: var(--colors-top);
			color: var(--colors-base);
			& + .wrapper > button {
				color: var(--colors-base);
			}
			&::placeholder {
				color: var(--colors-base);
			}
		}
		&:disabled {
			opacity: 1;
			border: 1px solid var(--colors-low);
			cursor: not-allowed;
			& + .wrapper > button {
				pointer-events: none;
				div {
					opacity: 0.25;
					cursor: not-allowed;
				}
			}
		}
	}
	.label {
		cursor: pointer;
		width: fit-content;
	}
	button {
		position: absolute;
		cursor: pointer;
		margin: 0;
		outline: none;
		border: none;
		background-color: transparent;
		padding: 0;
		width: 1.5rem;
		height: 1.5rem;
		color: var(--colors-ultra-high);
	}
	.default {
		.select {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.label {
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		button {
			right: var(--three-quarters-padding);
			bottom: var(--three-quarters-padding);
		}
	}
	.large {
		.select {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
		.label {
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
		button {
			right: var(--three-quarters-padding);
			bottom: calc(var(--three-quarters-padding) + var(--three-quarters-padding) / 3);
		}
	}
	.compact {
		.select {
			padding: var(--half-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.label {
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		button {
			right: var(--half-padding);
			bottom: var(--half-padding);
		}
	}
	.small {
		.select {
			padding: var(--half-padding);
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
		.label {
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
		button {
			right: var(--half-padding);
			bottom: var(--half-padding);
			width: 1rem;
			height: 1rem;
		}
	}
	.helper-text {
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
	.wrapper {
		position: relative;
	}
	.options {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 1;
		margin-top: 0.25rem;
		border-radius: var(--border-radius);
		background: var(--colors-base);
		width: 100%;

		div {
			display: flex;
			flex-direction: column;
			justify-content: stretch;
			align-items: stretch;
			border: 1px solid var(--colors-low);
			border-radius: var(--border-radius);
			padding: var(--half-padding);
			:global(.placeholder) {
				opacity: 0.5;
			}
		}
	}
	.hidden {
		display: none;
	}
</style>
