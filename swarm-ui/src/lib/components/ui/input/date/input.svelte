<!-- localization-exclude -->
<script lang="ts">
	import type { Snippet } from 'svelte'
	import Typography from '../../typography.svelte'
	import Input from '../input.svelte'
	import Calendar from './calendar.svelte'
	import { WarningAltFilled } from 'carbon-icons-svelte'

	type Dimension = 'default' | 'large' | 'compact' | 'small'

	export type Props = {
		label?: string
		yearLabel?: string
		yearPlaceholder?: string
		monthLabel?: string
		monthPlaceholder?: string
		dayLabel?: string
		dayPlaceholder?: string
		dimension?: Dimension
		error?: Snippet | string
		disabled?: boolean
		helperText?: Snippet | string
		variant: 'outline' | 'solid'
		value: Date | undefined
		errorMessages?: {
			invalidYear: string
			invalidMonth: string
			invalidDay: string
			invalidDate: string
		}
	}

	let {
		label,
		yearLabel = 'Year', // TODO: translate
		yearPlaceholder,
		monthLabel = 'Month', // TODO: translate
		monthPlaceholder,
		dayLabel = 'Day', // TODO: translate
		dayPlaceholder,
		dimension = 'default',
		error,
		disabled,
		helperText,
		variant = 'outline',
		value = $bindable(),
		errorMessages = {
			invalidYear: 'Invalid year', // TODO: translate
			invalidMonth: 'Invalid month', // TODO: translate
			invalidDay: 'Invalid day', // TODO: translate
			invalidDate: 'Invalid date', // TODO: translate
		},
	}: Props = $props()

	let year = $state('')
	let internalYear = $state('')
	let yearInput: HTMLInputElement | undefined = $state()
	let yearFocused = $state(false)
	let month = $state('')
	let internalMonth = $state('')
	let monthInput: HTMLInputElement | undefined = $state()
	let monthFocused = $state(false)
	let day = $state('')
	let internalDay = $state('')
	let dayInput: HTMLInputElement | undefined = $state()
	let dayFocused = $state(false)
	let internalError: string | undefined = $state()
	let showDatePicker = $state(false)
	const labelVariant = $derived(dimension === 'small' ? 'small' : 'default')
	const errorVariant = $derived(
		dimension === 'large'
			? 'large'
			: dimension === 'default' || dimension === 'compact'
				? 'default'
				: 'small',
	)
	const iconSize = $derived(
		dimension === 'large' ? 32 : dimension === 'default' || dimension === 'compact' ? 24 : 16,
	)
	const active = $derived(showDatePicker || yearFocused || monthFocused || dayFocused)

	function validateNumber(s: string) {
		if (s === '') {
			return true
		}

		if (!s.match(/^[0-9]+$/)) {
			return false
		}

		const numValue = parseInt(s, 10)
		if (isNaN(numValue)) {
			return false
		}
		return true
	}

	function validateRange(numValue: number, min: number, max: number) {
		if (isNaN(numValue)) {
			return false
		}
		if (numValue < min || numValue > max) {
			return false
		}
		return true
	}

	function validateYear() {
		if (!validateNumber(year)) {
			return false
		}

		const numValue = parseInt(year, 10)
		if (!validateRange(numValue, 1000, 9999)) {
			return false
		}

		return true
	}

	function validateMonth() {
		if (!validateNumber(month)) {
			return false
		}

		const numValue = parseInt(month, 10)
		if (!validateRange(numValue, 1, 12)) {
			return false
		}

		return true
	}

	function validateDay(daysOfMonth = 31) {
		if (!validateNumber(day)) {
			return false
		}

		const numValue = parseInt(day, 10)
		if (!validateRange(numValue, 1, daysOfMonth)) {
			return false
		}

		return true
	}

	function onYearInput(e: Event) {
		const cursorPosition = (e.currentTarget as HTMLInputElement).selectionStart ?? 0
		if (!validateNumber(year)) {
			year = internalYear
			e.preventDefault()
			return
		}

		internalYear = year
		if (year === '') {
			return
		}

		const numValue = parseInt(year, 10)
		const distanceFromEnd = year.length - cursorPosition
		if (validateRange(numValue, 1000, 9999) && distanceFromEnd === 0) {
			setDateValue()
			monthInput?.focus()
		}
	}

	function onMonthInput(e: Event) {
		const cursorPosition = (e.currentTarget as HTMLInputElement).selectionStart ?? 0
		if (!validateNumber(month)) {
			month = internalMonth
			e.preventDefault()
			return
		}

		internalMonth = month
		if (month === '') {
			return
		}

		const numValue = parseInt(month, 10)
		const distanceFromEnd = month.length - cursorPosition
		if (validateRange(numValue, 1, 12) && distanceFromEnd === 0 && month !== '1') {
			setDateValue()
			dayInput?.focus()
		}
	}

	function onDayInput(e: Event) {
		if (!validateNumber(day)) {
			day = internalDay
			e.preventDefault()
			return
		}

		internalDay = day
		if (day === '' || day === '0') {
			return
		}

		setDateValue()
	}

	function onYearBlur() {
		yearFocused = false
		if (!validateYear()) {
			internalError = errorMessages.invalidYear
			value = undefined
			return
		}

		setDateValue()
	}

	function onMonthBlur() {
		monthFocused = false
		if (!validateMonth()) {
			internalError = errorMessages.invalidMonth
			value = undefined
			return
		}

		if (month.length === 1) {
			month = month.padStart(2, '0')
		}

		setDateValue()
	}

	function onDayBlur() {
		dayFocused = false
		if (!validateDay()) {
			internalError = errorMessages.invalidDay
			value = undefined
			return
		}

		if (day.length === 1) {
			day = day.padStart(2, '0')
		}

		setDateValue()
	}

	function setDateValue() {
		value = undefined
		if (year === '' && month === '' && day === '') {
			internalError = undefined
			return
		}

		if (month === '' && day === '') {
			return
		}

		if (day === '') {
			return
		}

		if (!validateYear()) {
			internalError = errorMessages.invalidYear
			return
		}

		if (!validateMonth()) {
			internalError = errorMessages.invalidMonth
			return
		}

		if (!validateDay()) {
			internalError = errorMessages.invalidDay
			return
		}

		const isoString = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`
		const date = new Date(isoString)
		if (isNaN(Number(date))) {
			internalError = errorMessages.invalidDate
			return
		}

		if (date.toISOString() !== isoString) {
			internalError = errorMessages.invalidDate
			return
		}

		internalError = undefined
		value = date
	}

	function incrementInputValue(
		inputValue: string,
		increment: 1 | -1,
		min: number,
		max: number,
		padding: number,
	) {
		if (inputValue === '') {
			return
		}

		if (!validateNumber(inputValue)) {
			return
		}

		const numValue = parseInt(inputValue, 10)
		const newValue = numValue + increment
		if (newValue > max) {
			return min.toString().padStart(padding, '0')
		}
		if (newValue < min) {
			return max.toString().padStart(padding, '0')
		}
		return newValue.toString().padStart(padding, '0')
	}

	function onYearKeyDown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowUp': {
				e.preventDefault()
				const newValue = incrementInputValue(year, 1, 1000, 9999, 4)
				if (newValue) {
					year = internalYear = newValue
					setDateValue()
				}
				return
			}
			case 'ArrowDown': {
				e.preventDefault()
				const newValue = incrementInputValue(year, -1, 1000, 9000, 4)
				if (newValue) {
					year = internalYear = newValue
					setDateValue()
				}
				return
			}
		}
	}

	function onMonthKeyDown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowUp': {
				e.preventDefault()
				const newValue = incrementInputValue(month, 1, 1, 12, 2)
				if (newValue) {
					month = internalMonth = newValue
					setDateValue()
				}
				return
			}
			case 'ArrowDown': {
				e.preventDefault()
				const newValue = incrementInputValue(month, -1, 1, 12, 2)
				if (newValue) {
					month = internalMonth = newValue
					setDateValue()
				}
				return
			}
		}
	}

	function onDayKeyDown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowUp': {
				e.preventDefault()
				const newValue = incrementInputValue(day, 1, 1, 31, 2)
				if (newValue) {
					day = newValue
					setDateValue()
				}
				return
			}
			case 'ArrowDown': {
				e.preventDefault()
				const newValue = incrementInputValue(day, -1, 1, 31, 2)
				if (newValue) {
					day = newValue
					setDateValue()
				}
				return
			}
		}
	}

	$effect(() => {
		if (value) {
			if (document.activeElement !== yearInput) {
				year = value.getFullYear().toString().padStart(4, '0')
			}
			if (document.activeElement !== monthInput) {
				month = (value.getMonth() + 1).toString().padStart(2, '0')
			}
			if (document.activeElement !== dayInput) {
				day = value.getDate().toString().padStart(2, '0')
			}
		}
	})

	$effect(() => {
		if (!active) {
			setDateValue()
		}
	})
</script>

<div class="vertical">
	{#if label}
		<Typography variant={labelVariant}>{label}</Typography>
	{/if}
	<div class="horizontal">
		<div class="vertical">
			<Typography variant="small">{yearLabel}</Typography>
			<Input
				maxlength={4}
				size={4}
				bind:value={year}
				bind:input={yearInput}
				placeholder={yearPlaceholder}
				{dimension}
				{disabled}
				{variant}
				style="width: 4.5em; text-align: center"
				oninput={onYearInput}
				onfocus={() => (yearFocused = true)}
				onblur={onYearBlur}
				onkeydown={onYearKeyDown}
			/>
		</div>

		<div class={`input-separator ${dimension}`}>-</div>

		<div class="vertical">
			<Typography variant="small">{monthLabel}</Typography>
			<Input
				maxlength={2}
				size={2}
				bind:value={month}
				bind:input={monthInput}
				placeholder={monthPlaceholder}
				{dimension}
				{disabled}
				{variant}
				style="width: 3em; text-align: center"
				oninput={onMonthInput}
				onfocus={() => (monthFocused = true)}
				onblur={onMonthBlur}
				onkeydown={onMonthKeyDown}
			/>
		</div>

		<div class={`input-separator ${dimension}`}>-</div>

		<div class="vertical">
			<Typography variant="small">{dayLabel}</Typography>
			<Input
				maxlength={2}
				size={2}
				bind:value={day}
				bind:input={dayInput}
				placeholder={dayPlaceholder}
				{dimension}
				{disabled}
				{variant}
				style="width: 3em; text-align: center"
				oninput={onDayInput}
				onfocus={() => (dayFocused = true)}
				onblur={onDayBlur}
				onkeydown={onDayKeyDown}
			/>
		</div>

		<Calendar {dimension} {disabled} bind:dateValue={value} bind:showDatePicker tabindex={-1} />
	</div>
	{#if helperText}
		{#if typeof helperText === 'string'}
			<Typography variant="small"></Typography>{helperText}
		{:else}
			{@render helperText()}
		{/if}
	{/if}
	{#if error || internalError}
		{@const errorMessage = error || internalError}
		<div class="error">
			<WarningAltFilled size={iconSize} />
			{#if typeof errorMessage === 'string'}
				<Typography variant={errorVariant} --colors-ultra-high="var(--colors-base)"
					>{errorMessage}</Typography
				>
			{:else if errorMessage}
				{@render errorMessage()}
			{/if}
		</div>
	{/if}
</div>

<style lang="postcss">
	.vertical {
		display: flex;
		flex-direction: column;
		gap: var(--half-padding);
	}
	.horizontal {
		display: flex;
		flex-direction: row;
		gap: var(--half-padding);
		align-items: flex-end;
	}
	.input-separator {
		display: flex;
		align-items: center;
	}
	.input-separator.small {
		height: calc(var(--line-height-small) + 2 * var(--half-padding) + 2px);
	}
	.input-separator.compact {
		height: calc(var(--line-height) + 2 * var(--half-padding) + 2px);
	}
	.input-separator.default {
		height: calc(var(--line-height) + 2 * var(--three-quarters-padding) + 2px);
	}
	.input-separator.large {
		height: calc(var(--line-height-large) + 2 * var(--three-quarters-padding) + 2px);
	}
	.error {
		display: flex;
		align-items: center;
		gap: var(--half-padding);
		border-radius: var(--border-radius);
		background-color: var(--colors-top);
		color: var(--colors-base);
		padding: var(--quarter-padding) var(--three-quarters-padding);
	}
</style>
