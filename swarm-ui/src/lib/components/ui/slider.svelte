<script lang="ts">
	import Information from 'carbon-icons-svelte/lib/Information.svelte'
	import type { Snippet } from 'svelte'
	import type { HTMLInputAttributes } from 'svelte/elements'
	type Dimension = 'default' | 'large' | 'compact' | 'small'
	type Layout = 'horizontal' | 'vertical'
	interface Props extends HTMLInputAttributes {
		labelFor?: string
		dimension?: Dimension
		layout?: Layout
		centered?: boolean
		min?: number
		max?: number
		step?: number
		hover?: boolean
		active?: boolean
		focus?: boolean
		showSteps?: boolean
		helperText?: Snippet
		alwaysShowValue?: boolean
		withoutShowValue?: boolean
	}
	let {
		labelFor = Math.random().toString(16),
		dimension = 'default',
		layout = 'vertical',
		centered,
		min = 0,
		max = 100,
		step,
		hover,
		active,
		focus,
		showSteps = false,
		value = $bindable(min),
		helperText,
		children,
		alwaysShowValue = false,
		withoutShowValue = false,
		...restProps
	}: Props = $props()

	let percent = $derived(((value - min) / Math.abs(max - min)) * 100)
</script>

<div class="root {dimension} {layout}" style={`--valuePercent: ${percent}%`}>
	{#if children}
		<label for={labelFor}>
			{@render children()}
		</label>
	{/if}
	{#if helperText && layout === 'horizontal'}
		<div class="helper-button">
			<div class="helper-text-horizontal">
				{@render helperText()}
			</div>
			<Information size={dimension === 'small' ? 16 : 24} />
		</div>
	{/if}
	<div class="wrapper">
		{#if !alwaysShowValue || !withoutShowValue}
			<span>{min}</span>
		{/if}
		<div class="slider-container" class:centered>
			<input
				type="range"
				class:hover
				class:active
				class:focus
				id={labelFor}
				bind:value
				{min}
				{max}
				{step}
				{...restProps}
			/>
			{#if centered}
				<span class="center"></span>
			{/if}
			{#if !alwaysShowValue || !withoutShowValue}
				<div class="value-container">
					<span class="value">
						{value}
					</span>
				</div>
			{/if}
			<div class="slider-background"></div>
			<div class="slider-progress"></div>
			<div class="slider-progress-centered"></div>
			{#if showSteps && step}
				{@const stepCount = (max - min) / step}
				<div class="slider-tick-container">
					<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
					{#each Array.from({ length: stepCount + 1 }) as _, i}
						<span
							class="tick"
							style={`left: ${((i * step) / (max - min)) * 100}%`}
							class:hidden={i === stepCount / 2 && centered}
						></span>
					{/each}
				</div>
			{/if}
		</div>
		{#if !withoutShowValue}
			{#if !alwaysShowValue}
				<span class="max">{max}</span>
			{:else}
				<span class="continuous-value">{value}</span>
			{/if}
		{/if}
	</div>
	{#if helperText && layout === 'vertical'}
		<div class="helper-text">
			{@render helperText()}
		</div>
	{/if}
</div>

<style lang="postcss">
	.root {
		display: flex;
		gap: 0.5rem;
		width: 100%;
		max-width: 100%;
		color: var(--colors-ultra-high);
		font-family: var(--font-family-sans-serif);
		&.vertical {
			flex-direction: column;
		}
		&.horizontal {
			flex-direction: row;
			align-items: center;
		}
	}
	label {
		cursor: pointer;
		width: fit-content;
		white-space: nowrap;
	}
	.helper-button {
		position: relative;
		cursor: help;
		&:hover {
			.helper-text-horizontal {
				display: block;
			}
		}
		.helper-text-horizontal {
			display: none;
			position: absolute;
			top: calc(var(--half-padding) * -1);
			left: 50%;
			transform: translateX(-50%) translateY(-100%);
			border-radius: var(--border-radius);
			background-color: var(--colors-top);
			padding: var(--quarter-padding) var(--half-padding);
			color: var(--colors-base);
			font-size: var(--font-size-small);
			line-height: var(--line-height-small);
			letter-spacing: var(--letter-spacing-small);
			white-space: nowrap;
		}
	}
	.wrapper {
		display: flex;
		flex-grow: 1;
		align-items: center;
		gap: 0.5rem;
		padding: var(--three-quarters-padding);
		&:has(input:not(:disabled):active),
		&:has(input:not(:disabled).active) {
			color: var(--colors-high);
		}
		&:has(input:not(:disabled):hover),
		&:has(input:not(:disabled).hover) {
			color: var(--colors-high);
		}
		&:has(input:not(:disabled):focus-visible),
		&:has(input:not(:disabled).focus) {
			outline: var(--focus-outline);
			outline-offset: var(--focus-outline-offset);
			border-radius: var(--border-radius);
			background-color: var(--colors-base);
			color: var(--colors-top);
		}
		&:has(input:disabled) {
			opacity: 0.25;
			cursor: not-allowed;
		}
		&:has(.centered) {
			.max::before {
				content: '+';
			}
		}
	}
	.slider-container {
		display: flex;
		position: relative;
		flex-grow: 1;
		align-items: center;
	}

	input[type='range'] {
		appearance: none;
		z-index: 1;
		cursor: pointer;
		margin: 0;
		background: transparent;
		width: 100%;
		&::-webkit-slider-thumb {
			position: relative;
			appearance: none;
			z-index: 1;
			cursor: grab;
			margin-bottom: 0;
			outline: none;
			box-shadow: none;
			border: none;
			border-radius: 50%;
			background: var(--colors-ultra-high);
		}
		&::-moz-range-thumb {
			position: relative;
			appearance: none;
			z-index: 1;
			cursor: grab;
			margin-bottom: 0;
			outline: none;
			box-shadow: none;
			border: none;
			border-radius: 50%;
			background: var(--colors-ultra-high);
		}
		&::-webkit-slider-runnable-track {
			appearance: none;
			width: 100%;
		}
		&::-moz-range-track {
			appearance: none;
			width: 100%;
		}
		&:disabled::-webkit-slider-thumb {
			cursor: not-allowed;
		}
		&:disabled::-moz-range-thumb {
			cursor: not-allowed;
		}
		&:disabled::-webkit-slider-runnable-track {
			cursor: not-allowed;
		}
		&:disabled::-moz-range-track {
			cursor: not-allowed;
		}

		&:hover:not(:disabled):not(:focus-visible),
		&:active:not(:disabled):not(:focus-visible),
		&.hover:not(:disabled):not(:focus-visible),
		&.active:not(:disabled):not(:focus-visible) {
			&::-webkit-slider-thumb {
				background: var(--colors-high);
			}
			&::-moz-range-thumb {
				background: var(--colors-high);
			}
			& ~ .center {
				background: var(--colors-high);
			}
			& ~ .value-container > .value {
				opacity: 1;
			}
			& ~ .slider-background {
				background: var(--colors-high);
			}
			& ~ .slider-progress {
				background: var(--colors-high);
			}
			& ~ .slider-progress-centered {
				background: var(--colors-high);
			}
			& ~ .slider-tick-container > .tick {
				background: var(--colors-high);
			}
		}
		&:active:not(:disabled):focus-visible,
		&.active:not(:disabled).focus {
			&::-webkit-slider-thumb {
				background: var(--colors-top);
			}
			&::-moz-range-thumb {
				background: var(--colors-top);
			}
			& ~ .center,
			& ~ .slider-background,
			& ~ .slider-progress,
			& ~ .slider-progress-centered,
			& ~ .slider-tick-container > .tick {
				background: var(--colors-top);
			}
		}
		&:focus-visible:not(:disabled),
		&.focus:not(:disabled) {
			outline: none;
			&::-webkit-slider-thumb {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
			}
			&::-moz-range-thumb {
				outline: var(--focus-outline);
				outline-offset: var(--focus-outline-offset);
				background: var(--colors-base);
			}
			& ~ .center {
				background: var(--colors-top);
			}
			& ~ .value-container > .value {
				opacity: 1;
			}
			& ~ .slider-background {
				background: var(--colors-top);
			}
			& ~ .slider-progress {
				background: var(--colors-top);
			}
			& ~ .slider-progress-centered {
				background: var(--colors-top);
			}
			& ~ .slider-tick-container > .tick {
				background: var(--colors-top);
			}
		}
	}
	.centered {
		.slider-background {
			width: 100%;
		}
		.slider-progress {
			border-radius: 0;
		}
		.slider-progress-centered {
			border-radius: 0;
		}
		.center {
			position: absolute;
			left: 50%;
			transform: translateX(-50%);
			border-radius: 0.125rem;
			background: var(--colors-ultra-high);
			width: 0.125rem;
			height: 1.5rem;
		}
		.hidden {
			opacity: 0;
		}
	}
	.value-container {
		position: absolute;
		left: var(--valuePercent);
		transform: translateX(calc(var(--valuePercent) * -1));
		padding: 0 0.75rem;
	}
	.value {
		display: flex;
		position: absolute;
		top: -1.25rem;
		align-items: center;
		transform: translate(-50%, -100%);
		opacity: 0;
		border-radius: 0.75rem;
		background: var(--colors-top);
		padding: 0.25rem 0.5rem;
		color: var(--colors-base);
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}
	.continuous-value {
		text-align: center;
		white-space: nowrap;
		width: fit-content !important;
	}
	.slider-background {
		position: absolute;
		left: calc(var(--valuePercent));
		z-index: 0;
		border-radius: var(--border-radius);
		background: var(--colors-ultra-high);
		height: 1px;
	}
	.slider-progress,
	.slider-progress-centered {
		position: absolute;
		z-index: 0;
		border-radius: var(--border-radius);
		background-color: var(--colors-ultra-high);
		height: 4px;
	}
	.slider-progress-centered {
		border-radius: 0;
	}
	.slider-tick-container {
		position: absolute;
		left: 0.75rem;
		z-index: 0;
		width: calc(100% - 1.5rem);
	}
	.tick {
		position: absolute;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		background-color: var(--colors-ultra-high);
		width: 4px;
		height: 4px;
	}
	.helper-text {
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);
	}

	.default,
	.compact {
		font-size: var(--font-size);
		line-height: var(--line-height);
		letter-spacing: var(--letter-spacing);

		input[type='range'] {
			height: 1.5rem;
			&::-webkit-slider-thumb {
				width: 1.5rem;
				height: 1.5rem;
			}
			&::-moz-range-thumb {
				width: 1.5rem;
				height: 1.5rem;
			}
		}
		.centered {
			.slider-background {
				left: 0.75rem;
				width: calc(100% - 1.5rem);
			}
			.slider-progress {
				left: var(--valuePercent);
				width: calc((50% - var(--valuePercent)));
			}
			.slider-progress-centered {
				right: calc(100% - var(--valuePercent));
				width: calc((var(--valuePercent) - 50%));
			}
		}
		.continuous-value {
			width: 1.75rem;
		}
		.slider-background {
			top: 11.5px;
			width: calc(100% - var(--valuePercent) - 0.75rem);
		}
		.slider-progress {
			top: 10px;
			left: 0.75rem;
			width: calc(var(--valuePercent) - 0.75rem);
		}
	}
	.large {
		font-size: var(--font-size-large);
		line-height: var(--line-height-large);
		letter-spacing: var(--letter-spacing-large);

		input[type='range'] {
			height: 2rem;
			&::-webkit-slider-thumb {
				width: 2rem;
				height: 2rem;
			}
			&::-moz-range-thumb {
				width: 2rem;
				height: 2rem;
			}
		}
		.centered {
			.center {
				height: 2rem;
			}
			.slider-background {
				left: 1rem;
				width: calc(100% - 2rem);
			}
			.slider-progress {
				left: var(--valuePercent);
				width: calc((50% - var(--valuePercent)));
			}
			.slider-progress-centered {
				right: calc(100% - var(--valuePercent));
				width: calc((var(--valuePercent) - 50%));
			}
		}
		.value-container {
			padding: 0 1rem;
		}
		.value {
			top: -1.5rem;
			border-radius: 1.25rem;
			padding: 0.5rem 0.75rem;
			font-size: var(--font-size);
			line-height: var(--line-height);
			letter-spacing: var(--letter-spacing);
		}
		.continuous-value {
			width: 2.625rem;
		}
		.slider-background {
			top: 15.5px;
			width: calc(100% - var(--valuePercent) - 1rem);
		}
		.slider-progress {
			top: 14px;
			left: 1rem;
			width: calc(var(--valuePercent) - 1rem);
		}
		.slider-tick-container {
			left: 1rem;
			width: calc(100% - 1.75rem);
		}
	}
	.small {
		gap: 0.25rem;
		font-size: var(--font-size-small);
		line-height: var(--line-height-small);
		letter-spacing: var(--letter-spacing-small);

		input[type='range'] {
			height: 1rem;
			&::-webkit-slider-thumb {
				width: 1rem;
				height: 1rem;
			}
			&::-moz-range-thumb {
				width: 1rem;
				height: 1rem;
			}
		}
		.centered {
			.center {
				height: 1rem;
			}
			.slider-background {
				left: 0.5rem;
				width: calc(100% - 1rem);
			}
			.slider-progress {
				left: var(--valuePercent);
				width: calc((50% - var(--valuePercent)));
			}
			.slider-progress-centered {
				right: calc(100% - var(--valuePercent));
				width: calc((var(--valuePercent) - 50%));
			}
		}
		.value-container {
			padding: 0 0.5rem;
		}
		.value {
			top: -1rem;
		}
		.continuous-value {
			width: 1.375rem;
		}
		.slider-background {
			top: 7.5px;
			width: calc(100% - var(--valuePercent) - 0.5rem);
		}
		.slider-progress {
			top: 6px;
			left: 0.5rem;
			width: calc(var(--valuePercent) - 0.5rem);
		}
		.slider-tick-container {
			left: 0.5rem;
			width: calc(100% - 0.75rem);
		}
	}
</style>
