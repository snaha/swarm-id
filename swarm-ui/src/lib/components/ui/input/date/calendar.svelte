<script lang="ts">
	import { CaretDown, CaretUp, ChevronLeft, ChevronRight, Calendar } from 'carbon-icons-svelte'
	import Button from '../../button.svelte'
	import Divider from '../../divider.svelte'
	import { type Props as ButtonProps } from '../../button.svelte'
	import type { HTMLButtonAttributes } from 'svelte/elements'
	import Typography from '../../typography.svelte'

	type TypographyVariant = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'large' | 'default' | 'small'
	type Props = ButtonProps & {
		dateValue: Date | undefined
		showDatePicker?: boolean
	}

	let {
		dimension = 'default',
		disabled,
		dateValue = $bindable(),
		showDatePicker = $bindable(),
		class: className = '',
		children,
		...restProps
	}: Props & HTMLButtonAttributes = $props()

	let currentDate = new Date()
	let selectedMonth = $state(currentDate.getMonth())
	let selectedYear = $state(currentDate.getFullYear())
	let selectedDate = $state(currentDate)
	let showYearPicker = $state(false)
	let isMobile = $state(false)
	let size: 16 | 24 | 32 = $derived(dimension === 'large' ? 32 : dimension === 'small' ? 16 : 24)
	let typographyVariant: TypographyVariant = $derived(
		isMobile
			? 'small'
			: dimension === 'large'
				? 'large'
				: dimension === 'small'
					? 'small'
					: 'default',
	)
	let daysInMonth = $derived(new Date(selectedYear, selectedMonth + 1, 0).getDate())
	let firstDayOfMonth = $derived((new Date(selectedYear, selectedMonth, 1).getDay() + 6) % 7)
	let prevMonthDays = $derived(new Date(selectedYear, selectedMonth, 0).getDate())
	let totalCells = 42
	let calendarDays = $derived(
		Array.from({ length: totalCells }, (_, i) => {
			const dayNumber = i - firstDayOfMonth + 1
			if (dayNumber <= 0) {
				return {
					date: prevMonthDays + dayNumber,
					type: 'prev',
				}
			} else if (dayNumber > daysInMonth) {
				return {
					date: dayNumber - daysInMonth,
					type: 'next',
				}
			} else {
				return {
					date: dayNumber,
					type: 'current',
				}
			}
		}),
	)

	let datePicker: HTMLDivElement
	let rootElement: HTMLElement | undefined = $state()
	let selectedYearElement: HTMLSpanElement | undefined = $state(undefined)
	let bottomElement: HTMLElement | undefined = $state(undefined)
	let scrollTopPosition = $state(0)

	const months = getLocalMonthNames()
	const days = getLocalDayNames()

	function getLocalMonthNames() {
		const formatter = new Intl.DateTimeFormat(undefined, { month: 'long' })
		const monthNames = []
		for (let month = 0; month < 12; month++) {
			const date = new Date(2020, month, 1)
			monthNames.push(formatter.format(date))
		}
		return monthNames
	}
	function getLocalDayNames() {
		const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
		const dayNames = []
		for (let day = 0; day < 7; day++) {
			const date = new Date(2020, 0, day - 1)
			dayNames.push(formatter.format(date))
		}
		return dayNames
	}

	function changeMonth(direction: number) {
		selectedMonth += direction
		if (selectedMonth < 0) {
			selectedMonth = 11
			selectedYear--
		} else if (selectedMonth > 11) {
			selectedMonth = 0
			selectedYear++
		}
	}

	function changeYear(year: number) {
		selectedYear = year
		selectDate(currentDate.getDate())
		setTimeout(() => (showDatePicker = true))
	}

	function selectDate(date: number) {
		selectedDate = new Date(selectedYear, selectedMonth, date)
		dateValue = selectedDate
	}

	function isSelected(date: number) {
		return (
			selectedDate.getDate() === date &&
			selectedDate.getMonth() === selectedMonth &&
			selectedDate.getFullYear() === selectedYear
		)
	}

	function isCurrentDay(date: number) {
		return (
			date === currentDate.getDate() &&
			selectedMonth === currentDate.getMonth() &&
			selectedYear === currentDate.getFullYear()
		)
	}

	function close(e: MouseEvent) {
		const target = e.target as unknown as Node
		const isVisible = showDatePicker || showYearPicker
		if (isVisible) {
			if (!datePicker.contains(target)) {
				e.stopPropagation()
				showDatePicker = false
				showYearPicker = false
			}
		}
	}

	function onKeyUp(e: KeyboardEvent) {
		switch (e.key) {
			case 'Escape': {
				showDatePicker = false
				showYearPicker = false
				return
			}
		}
	}

	function isScrolledIntoView(el: HTMLElement, completelyVisible = true) {
		const rect = el.getBoundingClientRect()
		const elemTop = rect.top
		const elemBottom = rect.bottom

		if (completelyVisible) {
			// Only completely visible elements return true
			return elemTop >= 0 && elemBottom <= window.innerHeight
		} else {
			// Partially visible elements return true:
			return elemTop < window.innerHeight && elemBottom >= 0
		}
	}

	$effect(() => {
		if (dateValue) {
			selectedMonth = dateValue.getMonth()
			selectedYear = dateValue.getFullYear()
			selectedDate = dateValue
		}
	})

	$effect(() => {
		window.addEventListener('click', close)
		window.addEventListener('keyup', onKeyUp)
		return () => {
			window.removeEventListener('click', close)
			window.removeEventListener('keyup', onKeyUp)
		}
	})

	$effect(() => {
		selectedYear = selectedDate.getFullYear()
		selectedMonth = selectedDate.getMonth()
	})

	$effect(() => {
		if (showYearPicker) {
			selectedYearElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
		}
		if (showDatePicker) {
			scrollTopPosition = document.documentElement.scrollTop
			if (bottomElement && !isScrolledIntoView(bottomElement)) {
				bottomElement?.scrollIntoView({ block: 'end', behavior: 'smooth' })
			}
		} else {
			if (rootElement && !isScrolledIntoView(rootElement)) {
				document.documentElement.scrollTo({ top: scrollTopPosition, behavior: 'smooth' })
			}
		}
	})
	$effect(() => {
		const resize = () => {
			isMobile = window.innerWidth < 768
		}
		resize()
		window.addEventListener('resize', resize)
		return () => {
			window.removeEventListener('resize', resize)
		}
	})
</script>

<div class="calendar-root {dimension} {className}" bind:this={rootElement}>
	<Button
		{dimension}
		{disabled}
		active={showDatePicker}
		variant="ghost"
		onclick={(e: Event) => {
			e.stopPropagation()
			showDatePicker = !showDatePicker
			showYearPicker = false
		}}
		{...restProps}
	>
		<Calendar {size} />
		{#if children}
			{@render children()}
		{/if}
	</Button>
	<div class:modal={isMobile}>
		<div class="date-picker" class:showDatePicker bind:this={datePicker}>
			<div class="header">
				<div class="month">
					<Button
						dimension={isMobile ? 'small' : dimension}
						variant="solid"
						onclick={() => changeMonth(-1)}><ChevronLeft size={isMobile ? 16 : size} /></Button
					>
					<Button
						dimension={isMobile ? 'small' : dimension}
						variant="solid"
						onclick={() => changeMonth(1)}><ChevronRight size={isMobile ? 16 : size} /></Button
					>
					<div class="separator"></div>
					<div class="current-month">
						<Typography variant={typographyVariant} bold>{months[selectedMonth]}</Typography>
					</div>
				</div>
				<Button
					dimension={isMobile ? 'small' : dimension}
					variant="solid"
					onclick={(e: MouseEvent) => {
						e.stopPropagation()
						showYearPicker = !showYearPicker
					}}
				>
					{selectedYear}
					{#if showYearPicker}
						<CaretUp size={isMobile ? 16 : size} />
					{:else}
						<CaretDown size={isMobile ? 16 : size} />
					{/if}
				</Button>
			</div>
			{#if showYearPicker}
				<div class="year-picker">
					<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
					{#each Array(200) as _, i}
						{#if selectedYear === 1900 + i}
							<span bind:this={selectedYearElement}>
								<Button
									dimension={isMobile ? 'small' : dimension}
									variant="ghost"
									active={selectedYear === 1900 + i}
									onclick={() => {
										changeYear(1900 + i)
									}}>{1900 + i}</Button
								>
							</span>
						{:else}
							<Button
								dimension={isMobile ? 'small' : dimension}
								variant="ghost"
								active={selectedYear === 1900 + i}
								onclick={() => {
									changeYear(1900 + i)
								}}>{1900 + i}</Button
							>
						{/if}
					{/each}
				</div>
			{:else}
				<div class="calendar">
					<div class="days">
						{#each days as day}
							<Typography variant={typographyVariant}>{day}</Typography>
						{/each}
					</div>
					<Divider class="no-margin" />

					<div class="calendar-grid">
						{#each calendarDays as { date, type }}
							<Button
								dimension={isMobile ? 'small' : dimension}
								class={type === 'current' && isCurrentDay(date) && !isSelected(date)
									? 'current-day'
									: ''}
								active={type === 'current' && isSelected(date)}
								disabled={type === 'prev' || type === 'next'}
								style="justify-content:center;"
								variant="ghost"
								onclick={() => {
									if (type === 'current') selectDate(date)
									showDatePicker = false
								}}
							>
								{date}
							</Button>
						{/each}
					</div>
				</div>
			{/if}
			<div bind:this={bottomElement}></div>
		</div>
	</div>
</div>

<style lang="postcss">
	:global(input[type='date']::-webkit-calendar-picker-indicator) {
		display: none;
	}
	.calendar-root {
		position: relative;
	}
	.date-picker {
		display: flex;
		visibility: hidden;
		position: absolute;
		bottom: -0.25rem;
		left: 0;
		flex-direction: column;
		transform: translateY(100%);
		z-index: 1;
		border: 1px solid var(--colors-low);
		border-radius: var(--border-radius);
		background: var(--colors-base);
		&.showDatePicker {
			visibility: visible;
			animation: fadeInFromNone 0.2s ease-in;
		}
	}
	@keyframes fadeInFromNone {
		0% {
			opacity: 0;
		}

		100% {
			opacity: 1;
		}
	}

	.modal {
		display: none;
		position: fixed;
		top: 0;
		left: 0;
		z-index: 1;
		background-color: rgba(0, 0, 0, 0.6);
		width: 100%;
		height: 100%;
		overflow: hidden;
		&:has(.showDatePicker) {
			display: flex;
			justify-content: center;
			align-items: center;
		}
		.date-picker {
			bottom: unset;
			left: unset;
			transform: unset;
			width: fit-content;
			height: fit-content;
		}
	}
	.header {
		display: flex;
		flex-direction: row;
		justify-content: space-between;
		background-color: var(--colors-ultra-low);
		padding: var(--padding);
	}
	.month {
		display: flex;
		justify-content: flex-start;
		align-items: center;
		gap: var(--half-padding);
	}
	.current-month {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.days {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		flex-shrink: 1;
		gap: var(--half-padding);
		justify-items: center;
	}
	:global(.no-margin) {
		margin: 0 !important;
	}
	.calendar {
		display: flex;
		flex-direction: column;
		padding: var(--padding);
		gap: var(--half-padding);
	}
	.calendar-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		flex-shrink: 1;
		gap: var(--half-padding);
	}
	:global(.current-day) {
		text-decoration: underline !important;
		text-underline-offset: 0.25rem !important;
	}
	.year-picker {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		justify-content: center;
		gap: var(--half-padding);
		overflow-y: scroll;
		padding: var(--padding);
	}
	.default {
		.year-picker {
			max-height: 413px;
			min-width: 416px;
		}
	}
	.large {
		.year-picker {
			max-height: 469px;
			min-width: 472px;
		}
	}
	.compact {
		.year-picker {
			max-height: 365px;
			min-width: 360px;
		}
	}
	.small {
		.year-picker {
			max-height: 309px;
			min-width: 316px;
		}
	}
</style>
