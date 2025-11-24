<script lang="ts">
	import { untrack, type Snippet } from 'svelte'
	import type { Dimension } from '../../button.svelte'
	import Typography from '../../typography.svelte'
	import Calendar from './calendar.svelte'
	import { formatDate } from '$lib/utils/date'

	type Props = {
		label?: string
		placeholder?: string
		dimension?: Dimension
		disabled?: boolean
		helperText?: Snippet | string
		value: Date | undefined
		style?: string
		onchange?: () => void
	}

	let {
		label,
		placeholder = 'Select date...',
		dimension,
		disabled,
		helperText,
		value = $bindable(),
		style,
		onchange,
	}: Props = $props()

	let showDatePicker = $state(false)

	const labelVariant = $derived(dimension === 'small' ? 'small' : 'default')
	const dateString = $derived(value ? formatDate(value) : '')

	$effect(() => {
		value //eslint-disable-line @typescript-eslint/no-unused-expressions
		untrack(() => {
			if (onchange) onchange()
		})
	})
</script>

<div class="vertical">
	{#if label}
		<Typography variant={labelVariant}>{label}</Typography>
	{/if}
	<Calendar
		{dimension}
		{disabled}
		{style}
		bind:dateValue={value}
		bind:showDatePicker
		variant="solid"
		leftAlign
	>
		{#if value}
			{dateString}
		{:else}
			<span class="placeholder">{placeholder}</span>
		{/if}
	</Calendar>
	{#if helperText}
		{#if typeof helperText === 'string'}
			<Typography variant="small"></Typography>{helperText}
		{:else}
			{@render helperText()}
		{/if}
	{/if}
</div>

<style lang="postcss">
	.vertical {
		display: flex;
		flex-direction: column;
		gap: var(--half-padding);
		flex: 1;
	}
	.placeholder {
		opacity: 50%;
	}
</style>
