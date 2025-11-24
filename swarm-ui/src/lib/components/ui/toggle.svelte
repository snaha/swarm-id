<script lang="ts">
	// TODO: rename to switch.svelte
	import type { HTMLInputAttributes } from 'svelte/elements'
	type Dimension = 'default' | 'large' | 'compact' | 'small'
	interface Props extends HTMLInputAttributes {
		label: string
		dimension?: Dimension
		hover?: boolean
		active?: boolean
		focus?: boolean
	}
	let {
		label,
		dimension = 'default',
		hover,
		active,
		focus,
		class: className = '',
		checked = $bindable(),
		...restProps
	}: Props = $props()
</script>

<label class="{dimension} {className}" class:hover class:active class:focus>
	<input type="checkbox" bind:checked {...restProps} />
	{label}
</label>

<style lang="postcss">
	label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		border-radius: var(--border-radius);
		color: var(--colors-ultra-high);
		font-family: var(--font-family-sans-serif);
		&:has(input[type='checkbox']:checked) {
			color: var(--colors-high);
		}
		&:has(input[type='checkbox']:disabled) {
			opacity: 0.25;
			cursor: not-allowed;
		}
		&:has(input[type='checkbox']:not(:disabled):focus) {
			outline: none;
		}
		&:has(input[type='checkbox']:not(:disabled):focus-visible),
		&.focus:has(input[type='checkbox']:not(:disabled)) {
			outline: var(--focus-outline);
			outline-offset: var(--focus-outline-offset);
			background: var(--colors-base);
			color: var(--colors-top);
			input[type='checkbox'] {
				border: 1px solid var(--colors-top);
				&::after {
					background: var(--colors-top);
				}
				&:checked {
					border: 1px solid var(--colors-top);
					background: var(--colors-top);
				}
				&:checked::after {
					background: var(--colors-base);
				}
			}
		}
		&:active:has(input[type='checkbox']:not(:disabled)),
		&.active:has(input[type='checkbox']:not(:disabled)) {
			outline: none;
		}
		&:hover:has(input[type='checkbox']:not(:disabled)),
		&.hover:has(input[type='checkbox']:not(:disabled)),
		&:active:has(input[type='checkbox']:not(:disabled)),
		&.active:has(input[type='checkbox']:not(:disabled)) {
			color: var(--colors-high);
			&:has(input[type='checkbox']:checked) {
				color: var(--colors-ultra-high);
			}
			input[type='checkbox'] {
				border: 1px solid var(--colors-high);
				&::after {
					background: var(--colors-high);
				}
				&:checked {
					border: 1px solid var(--colors-ultra-high);
					background: var(--colors-ultra-high);
				}
				&:checked::after {
					background: var(--colors-base);
				}
			}
		}
	}
	input[type='checkbox'] {
		display: flex;
		position: relative;
		appearance: none;
		transition: transform 0.35s ease;
		cursor: pointer;
		margin: 0;
		border: 1px solid var(--colors-ultra-high);
		border-radius: 1rem;
		background: transparent;
		&:focus {
			outline: none;
		}
		&::after {
			position: absolute;
			top: 50%;
			left: 0.2rem;
			transform: translateY(-50%);
			transition: transform 0.35s cubic-bezier(0.5, 0.1, 0.75, 1.35);
			border-radius: 50%;
			background: var(--colors-ultra-high);
			content: '';
		}
		&:checked {
			border: 1px solid var(--colors-high);
			background: var(--colors-high);
		}
		&:checked::after {
			background: var(--colors-ultra-low);
		}
		&:disabled {
			opacity: 1;
			border: 1px solid var(--colors-low);
			cursor: not-allowed;
		}
	}
	.default {
		& {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		input[type='checkbox'] {
			width: 2.5rem;
			height: 1.5rem;
		}
		input[type='checkbox']::after {
			width: 1rem;
			height: 1rem;
		}
		input[type='checkbox']:checked::after {
			transform: translateY(-50%) translateX(1rem);
		}
	}

	.large {
		& {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
		input[type='checkbox'] {
			width: 3.5rem;
			height: 2rem;
		}
		input[type='checkbox']::after {
			width: 1.5rem;
			height: 1.5rem;
		}
		input[type='checkbox']:checked::after {
			transform: translateY(-50%) translateX(1.5rem);
		}
	}

	.compact {
		& {
			padding: var(--half-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		input[type='checkbox'] {
			width: 2.5rem;
			height: 1.5rem;
		}
		input[type='checkbox']::after {
			width: 1rem;
			height: 1rem;
		}
		input[type='checkbox']:checked::after {
			transform: translateY(-50%) translateX(1rem);
		}
	}

	.small {
		& {
			gap: 0.25rem;
			padding: var(--half-padding);
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
		input[type='checkbox'] {
			width: 1.625rem;
			height: 1rem;
		}
		input[type='checkbox']::after {
			left: 2px;
			width: 0.625rem;
			height: 0.625rem;
		}
		input[type='checkbox']:checked::after {
			transform: translateY(-50%) translateX(10px);
		}
	}
</style>
