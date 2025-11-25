<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements'
	type Dimension = 'default' | 'large' | 'compact' | 'small'
	interface Props extends HTMLInputAttributes {
		dimension?: Dimension
		hover?: boolean
		active?: boolean
		focus?: boolean
	}
	let {
		dimension = 'default',
		hover,
		checked = $bindable(),
		active,
		focus,
		children,
		class: className = '',
		...restProps
	}: Props = $props()
</script>

<label class="{dimension} {className}" class:hover class:active class:focus>
	<input type="checkbox" bind:checked {...restProps} />
	{#if children}{@render children()}{/if}
</label>

<style lang="postcss">
	label {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		border-radius: var(--border-radius);
		color: var(--colors-ultra-high);
		font-family: var(--font-family-sans-serif);
		&:has(input[type='checkbox']:checked) {
			color: var(--colors-high);
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

			input[type='checkbox']::before {
				border: 1px solid var(--colors-top);
			}
			input[type='checkbox']:checked::before {
				border: 1px solid var(--colors-top);
				background: var(--colors-top);
			}
			&:has(input[type='checkbox']:checked) {
				color: var(--colors-top);
			}
		}
		&:has(input[type='checkbox']:disabled) {
			opacity: 1;
			border: 1px solid var(--colors-low);
			cursor: not-allowed;
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
			input[type='checkbox']::before {
				border: 1px solid var(--colors-high);
			}
			input[type='checkbox']:checked::before {
				border: 1px solid var(--colors-ultra-high);
				background: var(--colors-ultra-high);
			}
		}
	}

	input[type='checkbox'] {
		position: relative;
		appearance: none;
		margin: 0;
	}
	input[type='checkbox']:focus {
		outline: none;
	}
	input[type='checkbox']::before {
		display: flex;
		align-items: flex-start;
		cursor: pointer;
		border: 1px solid var(--colors-ultra-high);
		border-radius: var(--border-radius);
		content: '';
	}
	input[type='checkbox']:checked::before {
		border: 1px solid var(--colors-high);
		background: var(--colors-high);
	}
	input[type='checkbox']:checked::after {
		position: absolute;
		top: 40%;
		left: 50%;
		transform: translate(-50%, -50%) rotate(45deg);
		border-right: 2px solid var(--colors-ultra-low);
		border-bottom: 2px solid var(--colors-ultra-low);
		content: '';
	}

	input[type='checkbox']:checked:disabled::before,
	input[type='checkbox']:disabled::before {
		cursor: not-allowed;
	}
	input[type='checkbox']:checked:disabled::after {
		cursor: not-allowed;
	}

	.default {
		& {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		input[type='checkbox'] {
			width: 1.5rem;
			height: 1.5rem;
		}
		input[type='checkbox']:checked::after {
			width: 0.5rem;
			height: 1rem;
		}
		input[type='checkbox']::before {
			width: 1.5rem;
			height: 1.5rem;
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
			width: 2rem;
			height: 2rem;
		}
		input[type='checkbox']:checked::after {
			border-right-width: 3px;
			border-bottom-width: 3px;
			width: 0.75rem;
			height: 1.25rem;
		}
		input[type='checkbox']::before {
			width: 2rem;
			height: 2rem;
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
			width: 1.5rem;
			height: 1.5rem;
		}
		input[type='checkbox']:checked::after {
			width: 0.5rem;
			height: 1rem;
		}
		input[type='checkbox']::before {
			width: 1.5rem;
			height: 1.5rem;
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
			width: 1rem;
			height: 1rem;
		}
		input[type='checkbox']:checked::after {
			border-right-width: 1.5px;
			border-bottom-width: 1.5px;
			width: 0.25rem;
			height: 0.5rem;
		}
		input[type='checkbox']::before {
			width: 1rem;
			height: 1rem;
		}
	}
</style>
