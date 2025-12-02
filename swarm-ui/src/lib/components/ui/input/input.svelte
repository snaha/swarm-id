<script lang="ts" module>
	import type { Snippet } from 'svelte'
	import type { HTMLInputAttributes } from 'svelte/elements'
	import Information from 'carbon-icons-svelte/lib/Information.svelte'

	type Layout = 'vertical' | 'horizontal'
	type Dimension = 'default' | 'large' | 'compact' | 'small'
	type Variant = 'outline' | 'solid'

	export type Props = {
		label?: Snippet | string
		labelFor?: string
		dimension?: Dimension
		layout?: Layout
		unit?: string
		error?: Snippet | string
		helperText?: string | Snippet
		hover?: boolean
		active?: boolean
		focus?: boolean
		disabled?: boolean
		buttons?: Snippet<[HTMLInputElement]>
		variant?: Variant
		iconStart?: Snippet
		input?: HTMLInputElement
	}
</script>

<script lang="ts">
	let {
		label,
		labelFor = Math.random().toString(16),
		placeholder = '',
		value = $bindable(),
		dimension = 'default',
		layout = 'vertical',
		unit,
		error,
		helperText,
		hover,
		iconStart,
		active,
		focus,
		type,
		disabled,
		class: className = '',
		buttons,
		variant = 'outline',
		input = $bindable(),
		...restProps
	}: Props & HTMLInputAttributes = $props()
</script>

<div class="root {layout} {dimension} {className}">
	{#if label}
		<label class="label" for={labelFor}>
			{#if typeof label === 'string'}
				{label}
			{:else}
				{@render label()}
			{/if}
		</label>
	{/if}
	{#if helperText && layout === 'horizontal'}
		<div class="helper-button">
			<Information size={dimension === 'small' ? 16 : 24} />
		</div>
	{/if}
	<div class="col">
		<div class="wrapper">
			<div class="relative">
				<input
					id={labelFor}
					class={variant}
					class:active
					class:hover
					class:focus
					class:error
					bind:value
					bind:this={input}
					{placeholder}
					{type}
					{disabled}
					{...restProps}
				/>
				{#if iconStart}
					<label for={labelFor} class="start-icon">
						{@render iconStart()}
					</label>
				{/if}
				{#if unit && !error}
					<label class="unit" for={labelFor}>{unit}</label>
				{/if}
			</div>
			{#if buttons}
				<label for={labelFor} class="control-buttons">
					{@render buttons(input)}
				</label>
			{/if}
		</div>
		{#if error}
			<div class="error-message">
				{#if typeof error === 'string'}
					{error}
				{:else}
					{@render error()}
				{/if}
			</div>
		{/if}
		{#if helperText && layout === 'vertical'}
			<div class="helper-text">
				{#if typeof helperText === 'string'}
					{helperText}
				{:else}
					{@render helperText()}
				{/if}
			</div>
		{/if}
	</div>
</div>

<style lang="postcss">
	input[type='search'] {
		-moz-appearance: textfield;
	}
	input[type='search']::-webkit-search-cancel-button {
		display: none;
	}

	input {
		font-family: var(--font-family-sans-serif);
	}
	input[type='number']::-webkit-outer-spin-button,
	input[type='number']::-webkit-inner-spin-button {
		appearance: none;
	}
	input[type='number'] {
		-moz-appearance: textfield;
	}
	input[type='date'] {
		cursor: text;
		font-family: var(--font-family-sans-serif);
		text-transform: uppercase;
	}
	input[type='date']::-webkit-datetime-edit {
		font-family: var(--font-family-sans-serif);
		text-transform: uppercase;
	}

	.vertical {
		&.root {
			display: flex;
			flex-direction: column;
			justify-content: center;
		}
	}
	.horizontal {
		&.root {
			display: flex;
			flex-direction: row;
			align-items: center;
		}
	}
	.root:has(.control-buttons) {
		.wrapper {
			flex-direction: row;
			gap: var(--half-padding);
			input {
				border-radius: var(--border-radius) 0 0 var(--border-radius);
			}
			.control-buttons {
				display: flex;
			}
		}
	}
	.wrapper:has(.relative):has(input:placeholder-shown):has(.start-icon) {
		flex-direction: row;
		gap: 0;
		input {
			border-radius: var(--border-radius) 0 0 var(--border-radius);
		}
		.control-buttons {
			display: none;
		}
	}
	.wrapper:has(.relative):has(input[type='search']:placeholder-shown) {
		.control-buttons > :global(*:first-child) :global(button) {
			display: none;
		}
	}
	.root {
		gap: var(--quarter-padding);
		color: var(--colors-ultra-high);
		font-family: var(--font-family-sans-serif);
	}
	.label {
		display: flex;
		flex-direction: column;
		cursor: pointer;
		width: fit-content;
		color: var(--colors-ultra-high);
	}
	.helper-button {
		display: flex;
		align-items: center;
		cursor: pointer;
	}
	.col {
		display: flex;
		flex-grow: 1;
		flex-direction: column;
		gap: 0.25rem;
	}
	.wrapper {
		display: flex;
		position: relative;
		flex-grow: 1;
		flex-direction: column;
		gap: 0.25rem;
		.relative {
			display: flex;
			position: relative;
			flex-grow: 1;
			flex-direction: row;
		}
		.control-buttons {
			display: flex;
			flex-direction: row;

			:global(button) {
				border-left: none;
				border-radius: 0;

				&:hover,
				&:active,
				&:focus {
					border-left: none;
				}
			}

			& > :global(*:last-child) :global(button) {
				border-radius: 0 var(--border-radius) var(--border-radius) 0;
			}
		}
		.control-buttons {
			display: none;
		}
		.outline {
			border: 1px solid var(--colors-ultra-high);
			background: transparent;
		}
		.solid {
			border: 1px solid var(--colors-low);
			background: var(--colors-base);
			&.date-wrapper::after {
				background: var(--colors-base);
			}
		}
		input {
			flex-grow: 1;
			border-radius: var(--border-radius);
			color: var(--colors-ultra-high);
			&::placeholder {
				opacity: 0.5;
				color: var(--colors-ultra-high);
			}
			&:disabled {
				opacity: 1;
				border: 1px solid var(--colors-low);
				cursor: not-allowed;
				& ~ .start-icon,
				& ~ .unit {
					opacity: 0.25;
					cursor: not-allowed;
				}
			}
			&:focus:not(:disabled),
			&:focus-visible:not(:disabled),
			&.focus:not(:disabled) {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
				color: var(--colors-top);
				& ~ .unit {
					opacity: 1;
					color: var(--colors-top);
				}
			}
			&:focus::placeholder {
				color: transparent;
			}
			&:active:not(:disabled),
			&.active:not(:disabled) {
				outline: none;
			}
			&:hover:not(:disabled),
			&.hover:not(:disabled),
			&:active:not(:disabled),
			&.active:not(:disabled) {
				border: 1px solid var(--colors-top);
				color: var(--colors-top);
			}
			&.error:not(:disabled) {
				outline: 1px solid var(--colors-red);
				outline-offset: -1px;
				color: var(--colors-red);
			}
		}
	}
	.start-icon {
		display: flex;
		position: absolute;
		align-items: center;
		cursor: text;
		color: var(--colors-ultra-high);
	}
	.unit {
		position: absolute;
		opacity: 0.5;
		cursor: text;
	}
	.default {
		&:has(.start-icon) {
			input {
				padding-left: 44px;
			}
		}
		.label {
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.helper-button {
			padding: var(--three-quarters-padding);
		}
		input {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.start-icon {
			padding: var(--three-quarters-padding) var(--half-padding) var(--three-quarters-padding)
				var(--three-quarters-padding);
		}
		.unit {
			top: var(--three-quarters-padding);
			right: var(--three-quarters-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.error-icon {
			top: var(--three-quarters-padding);
			right: var(--three-quarters-padding);
		}
	}
	.large {
		&:has(.start-icon) {
			input {
				padding-left: 52px;
			}
		}
		.label {
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
		.helper-button {
			padding: var(--three-quarters-padding);
		}
		input {
			padding: var(--three-quarters-padding);
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
		.start-icon {
			padding: var(--three-quarters-padding) var(--half-padding) var(--three-quarters-padding)
				var(--three-quarters-padding);
		}
		.unit {
			top: var(--three-quarters-padding);
			right: var(--three-quarters-padding);
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
		.error-icon {
			top: var(--padding);
			right: var(--three-quarters-padding);
		}
		.error-message {
			font-size: var(--font-size-large);
			line-height: var(--line-height-large);
			letter-spacing: var(--letter-spacing-large);
		}
	}
	.compact {
		&:has(.start-icon) {
			input {
				padding-left: 40px;
			}
		}
		.label {
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.helper-button {
			padding: var(--half-padding);
		}
		input {
			padding: var(--half-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.start-icon {
			padding: var(--half-padding);
		}
		.unit {
			top: var(--half-padding);
			right: var(--half-padding);
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.error-icon {
			top: var(--half-padding);
			right: var(--half-padding);
		}
	}
	.small {
		&:has(.start-icon) {
			input {
				padding-left: var(--double-padding);
			}
		}
		.label {
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
		.helper-button {
			padding: var(--half-padding);
		}
		input {
			padding: var(--half-padding);
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
		.start-icon {
			padding: var(--half-padding);
		}
		.unit {
			top: var(--half-padding);
			right: var(--half-padding);
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
		.error-icon {
			top: var(--half-padding);
			right: var(--half-padding);
		}
		.error-message {
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
		}
	}
	.error-message {
		border-radius: var(--border-radius);
		background: var(--colors-red);
		padding: var(--quarter-padding) var(--half-padding);
		color: var(--colors-base);
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);
	}
	.helper-text {
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
</style>
