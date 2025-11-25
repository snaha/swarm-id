import { formatNumber } from '$lib/utils/format'
import { parseFormattedValue } from './logic'

export interface FormatOptions {
	maximumFractionDigits: number
}

export interface InputStore {
	readonly value: number | undefined
	readonly displayValue: string
	readonly isFocused: boolean
	updateValue: (formattedValue: string, locale: string | null | undefined) => void
	setValue: (newValue: number | undefined) => void
	setDisplayValue: (newDisplayValue: string) => void
	updateDisplayValue: (
		value: number | undefined,
		locale: string | null | undefined,
		options: FormatOptions,
	) => void
	setFocus: (focused: boolean) => void
}

export function withInputStore(initialValue?: number): InputStore {
	let value = $state<number | undefined>(initialValue)
	let displayValue = $state(
		initialValue !== undefined && initialValue !== null ? String(initialValue) : '',
	)
	let isFocused = $state(false)

	return {
		get value() {
			return value
		},
		get displayValue() {
			return displayValue
		},
		get isFocused() {
			return isFocused
		},

		updateValue(formattedValue: string, locale: string | null | undefined) {
			const parsedValue = parseFormattedValue(formattedValue, locale)
			if (parsedValue !== undefined) {
				value = parsedValue
			} else if (formattedValue === '') {
				value = undefined
			} else if (formattedValue === '-') {
				// Just minus sign - keep display but don't change value yet
			}
		},

		setValue(newValue: number | undefined) {
			value = newValue
		},

		setDisplayValue(newDisplayValue: string) {
			displayValue = newDisplayValue
		},

		// Update display value from a numeric value
		updateDisplayValue(
			newValue: number | undefined,
			locale: string | null | undefined,
			options: FormatOptions,
		) {
			value = newValue

			if (!isFocused) {
				if (newValue !== undefined && newValue !== null) {
					displayValue = formatNumber(newValue, locale, {
						maximumFractionDigits: options.maximumFractionDigits,
					})
				} else {
					displayValue = ''
				}
			}
		},

		setFocus(focused: boolean) {
			isFocused = focused
		},
	}
}
