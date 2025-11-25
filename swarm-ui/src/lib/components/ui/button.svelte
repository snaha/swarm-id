<script lang="ts" module>
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements'
	export type Variant = 'strong' | 'secondary' | 'ghost' | 'solid' | 'darkoverlay' | 'lightoverlay'
	export type Dimension = 'default' | 'large' | 'compact' | 'small'
	export type Mode = 'light' | 'dark' | 'auto'
	type ButtonProps = {
		variant?: Variant
		active?: boolean
		hover?: boolean
		focus?: boolean
		dimension?: Dimension
		mode?: Mode
		leftAlign?: boolean
		flexGrow?: boolean
		busy?: boolean
		danger?: boolean
	}
	interface AnchorElement extends HTMLAnchorAttributes, ButtonProps {
		href?: HTMLAnchorAttributes['href']
		type?: never
		disabled?: boolean
	}

	interface ButtonElement extends HTMLButtonAttributes, ButtonProps {
		type?: HTMLButtonAttributes['type']
		href?: never
		disabled?: boolean
	}
	export type Props = AnchorElement | ButtonElement
</script>

<script lang="ts">
	let {
		dimension = 'default',
		variant = 'strong',
		active = $bindable(),
		hover,
		focus,
		disabled = $bindable(),
		href,
		class: className = '',
		leftAlign = false,
		flexGrow = false,
		busy = $bindable(false),
		danger = false,
		children,
		mode = 'auto',
		style,
		...restProps
	}: Props = $props()
</script>

<span class={`root ${className}`} class:disabled {style} class:flexGrow class:busy>
	<svelte:element
		this={href ? 'a' : 'button'}
		class={`${dimension} ${variant} ${mode}`}
		class:leftAlign
		class:active
		class:hover
		class:focus
		class:danger
		class:busy
		{href}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</svelte:element>
</span>

<style lang="postcss">
	.root {
		display: flex;
		flex-grow: 0;
		flex-direction: row;
		justify-content: stretch;
		align-items: stretch;
		position: relative;

		&.disabled {
			opacity: 0.25;
			cursor: not-allowed;

			a,
			button {
				pointer-events: none;
			}
		}
		&.busy {
			cursor: wait;
		}
	}
	button,
	a {
		display: inline-flex;
		flex-grow: 1;
		flex-shrink: 0;
		justify-content: center;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		border: 1px solid var(--colors-ultra-high);
		border-radius: var(--border-radius);
		font-style: normal;
		font-weight: 400;
		font-family: var(--font-family-sans-serif);
		text-decoration: none;
		white-space: nowrap;
		&.busy {
			cursor: wait;
		}
	}

	.leftAlign {
		justify-content: flex-start;
	}

	.flexGrow {
		flex-grow: 1 !important;
	}

	.danger {
		color: var(--colors-red) !important;
	}

	.default {
		padding: var(--three-quarters-padding);
		min-width: 3rem;
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.large {
		padding: var(--three-quarters-padding);
		min-width: 3.5rem;
		font-size: var(--font-size-large);
		line-height: var(--line-height-large);
		letter-spacing: var(--letter-spacing-large);
	}
	.compact {
		padding: var(--half-padding);
		min-width: 2.5rem;
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.small {
		gap: 0.25rem;
		padding: var(--half-padding);
		min-width: 2rem;
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
	.auto {
		&.strong {
			border: 1px solid transparent;
			background: var(--colors-ultra-high);
			color: var(--colors-ultra-low);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-high);
				color: var(--colors-base);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-top);
				color: var(--colors-base);
			}
		}
		&.secondary {
			border: 1px solid var(--colors-ultra-high);
			background: none;
			color: var(--colors-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				border: 1px solid transparent;
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				border: 1px solid var(--colors-high);
				background: var(--colors-low);
				color: var(--colors-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				border: 1px solid var(--colors-top);
				background: var(--colors-low);
				color: var(--colors-top);
			}
		}
		&.ghost {
			border: 1px solid transparent;
			background: transparent;
			color: var(--colors-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-low);
				color: var(--colors-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-low);
				color: var(--colors-top);
			}
		}
		&.solid {
			border: 1px solid var(--colors-low);
			background: var(--colors-base);
			color: var(--colors-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-low);
				color: var(--colors-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-low);
				color: var(--colors-top);
			}
		}
		&.darkoverlay {
			border: 1px solid transparent;
			background: var(--colors-dark-overlay);
			color: var(--colors-dark-top);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}
		}

		&.lightoverlay {
			border: 1px solid transparent;
			background: var(--colors-light-overlay);
			color: var(--colors-light-top);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}
		}
	}
	.dark {
		&.strong {
			border: 1px solid transparent;
			background: var(--colors-dark-ultra-high);
			color: var(--colors-dark-ultra-low);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-dark-top);
				color: var(--colors-dark-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-dark-high);
				color: var(--colors-dark-base);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-dark-top);
				color: var(--colors-dark-base);
			}
		}
		&.secondary {
			border: 1px solid var(--colors-dark-ultra-high);
			background: none;
			color: var(--colors-dark-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				border: 1px solid transparent;
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-dark-top);
				color: var(--colors-dark-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				border: 1px solid var(--colors-dark-high);
				background: var(--colors-dark-low);
				color: var(--colors-dark-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				border: 1px solid var(--colors-dark-top);
				background: var(--colors-dark-low);
				color: var(--colors-dark-top);
			}
		}
		&.ghost {
			border: 1px solid transparent;
			background: transparent;
			color: var(--colors-dark-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-dark-top);
				color: var(--colors-dark-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-dark-low);
				color: var(--colors-dark-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-dark-low);
				color: var(--colors-dark-top);
			}
		}
		&.solid {
			border: 1px solid var(--colors-dark-low);
			background: var(--colors-dark-base);
			color: var(--colors-dark-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-dark-top);
				color: var(--colors-dark-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-dark-low);
				color: var(--colors-dark-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-dark-low);
				color: var(--colors-dark-top);
			}
		}
		&.darkoverlay {
			border: 1px solid transparent;
			background: var(--colors-dark-overlay);
			color: var(--colors-dark-top);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}
		}

		&.lightoverlay {
			border: 1px solid transparent;
			background: var(--colors-light-overlay);
			color: var(--colors-light-top);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}
		}
	}
	.light {
		&.strong {
			border: 1px solid transparent;
			background: var(--colors-light-ultra-high);
			color: var(--colors-light-ultra-low);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-light-top);
				color: var(--colors-light-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-light-high);
				color: var(--colors-light-base);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-light-top);
				color: var(--colors-light-base);
			}
		}
		&.secondary {
			border: 1px solid var(--colors-light-ultra-high);
			background: none;
			color: var(--colors-light-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				border: 1px solid transparent;
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-light-top);
				color: var(--colors-light-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				border: 1px solid var(--colors-light-high);
				background: var(--colors-light-low);
				color: var(--colors-light-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				border: 1px solid var(--colors-light-top);
				background: var(--colors-light-low);
				color: var(--colors-light-top);
			}
		}
		&.ghost {
			border: 1px solid transparent;
			background: transparent;
			color: var(--colors-light-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-light-top);
				color: var(--colors-light-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-light-low);
				color: var(--colors-light-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-light-low);
				color: var(--colors-light-top);
			}
		}
		&.solid {
			border: 1px solid var(--colors-light-low);
			background: var(--colors-light-base);
			color: var(--colors-light-ultra-high);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-light-top);
				color: var(--colors-light-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-light-low);
				color: var(--colors-light-high);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-light-low);
				color: var(--colors-light-top);
			}
		}
		&.darkoverlay {
			border: 1px solid transparent;
			background: var(--colors-dark-overlay);
			color: var(--colors-dark-top);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-dark-base);
				color: var(--colors-dark-top);
			}
		}

		&.lightoverlay {
			border: 1px solid transparent;
			background: var(--colors-light-overlay);
			color: var(--colors-light-top);

			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
			}

			&:focus-visible:not(:disabled):active,
			&.focus:not(:disabled).active {
				outline: none;
				background: var(--colors-top);
				color: var(--colors-base);
			}

			&:hover:not(:disabled),
			&.hover:not(:disabled) {
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}

			&:active:not(:disabled),
			&.active:not(:disabled) {
				background: var(--colors-light-base);
				color: var(--colors-light-top);
			}
		}
	}
</style>
