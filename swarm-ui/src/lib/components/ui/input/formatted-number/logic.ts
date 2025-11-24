import { formatNumber, parseLocalizedNumber } from '$lib/utils/format'

export const DEFAULT_MAXIMUM_FRACTION_DIGITS = 2
export const MAX_INTEGER_DIGITS = 15 // Reasonable limit for financial data (up to 999 trillion)

export interface LocaleSeparators {
	decimalSeparator: string
	groupSeparator: string
}

export interface FormatResult {
	formattedValue: string
	newCursorPos: number
}

// Get locale-specific separators
export function getLocaleSeparators(locale: string | null | undefined): LocaleSeparators {
	const formatter = new Intl.NumberFormat(locale || undefined)
	const parts = formatter.formatToParts(1234.5)

	const decimalSeparator = parts.find((part) => part.type === 'decimal')?.value || '.'
	const groupSeparator = parts.find((part) => part.type === 'group')?.value || ','

	return { decimalSeparator, groupSeparator }
}

// Check if character is valid for numeric input
export function isValidChar(
	char: string,
	locale: string | null | undefined,
	min?: number,
): boolean {
	if (/[0-9]/.test(char)) return true // Digits always allowed

	// Allow both . and , as decimal separators for better UX
	if (char === '.' || char === ',') return true

	const { groupSeparator } = getLocaleSeparators(locale)
	if (char === groupSeparator) return true

	// Only allow minus sign if min is not set or allows negative numbers
	if (char === '-' && (min === undefined || min < 0)) return true

	return false
}

// Convert formatted string to unformatted (remove thousand separators)
export function toUnformatted(formattedValue: string, locale: string | null | undefined): string {
	const { groupSeparator } = getLocaleSeparators(locale)
	return formattedValue.replace(new RegExp(`\\${groupSeparator}`, 'g'), '')
}

// Convert cursor position from formatted string to unformatted position
export function formattedToUnformattedPos(
	formattedValue: string,
	formattedPos: number,
	locale: string | null | undefined,
): number {
	const { groupSeparator } = getLocaleSeparators(locale)
	let unformattedPos = 0
	for (let i = 0; i < Math.min(formattedPos, formattedValue.length); i++) {
		if (formattedValue[i] !== groupSeparator) {
			unformattedPos++
		}
	}
	return unformattedPos
}

// Convert cursor position from unformatted string to formatted position
export function unformattedToFormattedPos(
	formattedValue: string,
	unformattedPos: number,
	locale: string | null | undefined,
): number {
	const { groupSeparator } = getLocaleSeparators(locale)
	let unformattedCount = 0

	// Handle edge case where unformattedPos is 0
	if (unformattedPos === 0) return 0

	for (let i = 0; i < formattedValue.length; i++) {
		if (formattedValue[i] !== groupSeparator) {
			unformattedCount++
			if (unformattedCount === unformattedPos) {
				return i + 1
			}
		}
	}
	return formattedValue.length
}

// Apply live formatting and calculate new cursor position
export function applyLiveFormatting(
	rawValue: string,
	cursorPos: number,
	locale: string | null | undefined,
	maximumFractionDigits: number = DEFAULT_MAXIMUM_FRACTION_DIGITS,
): FormatResult {
	const { decimalSeparator, groupSeparator } = getLocaleSeparators(locale)

	// First, remove all group separators to get the raw numeric value
	const unformattedValue = toUnformatted(rawValue, locale)

	// Calculate cursor position in the unformatted string
	// We need to count how many actual digits/characters are before the cursor,
	// excluding any group separators
	let unformattedCursorPos = 0
	for (let i = 0; i < Math.min(cursorPos, rawValue.length); i++) {
		if (rawValue[i] !== groupSeparator) {
			unformattedCursorPos++
		}
	}

	// Handle empty input immediately
	if (unformattedValue === '') {
		return { formattedValue: '', newCursorPos: 0 }
	}

	// Check if user is typing a decimal separator at the end
	const endsWithDecimal = unformattedValue.endsWith('.') || unformattedValue.endsWith(',')

	// Handle special cases before parsing
	if (unformattedValue === '-') {
		return { formattedValue: unformattedValue, newCursorPos: unformattedCursorPos }
	}

	// Handle decimal-only input - format as "0." with cursor after decimal
	if (unformattedValue === '.' || unformattedValue === ',') {
		const formatted = '0' + decimalSeparator
		return { formattedValue: formatted, newCursorPos: formatted.length }
	}

	// Normalize multiple consecutive zeros to a single zero
	if (/^0+$/.test(unformattedValue)) {
		return { formattedValue: '0', newCursorPos: 1 }
	}

	// Parse the clean value
	const numericValue = parseLocalizedNumber(unformattedValue, locale)

	// If invalid number, keep original input
	if (
		isNaN(numericValue) ||
		(numericValue === 0 && unformattedValue !== '0' && !unformattedValue.match(/^0[.,]/))
	) {
		return { formattedValue: rawValue, newCursorPos: cursorPos }
	}

	// Check if the unformatted value has trailing zeros after decimal
	const decimalMatch = unformattedValue.match(/[.,](\d*)$/)
	const hasTrailingZeros = decimalMatch && decimalMatch[1].includes('0')

	// Format the number
	let formatted = formatNumber(numericValue, locale, {
		maximumFractionDigits: maximumFractionDigits,
	})

	// If user has typed decimal with trailing zeros, we need to preserve them
	if (hasTrailingZeros || endsWithDecimal) {
		const decimalPart = decimalMatch ? decimalMatch[1] : ''

		// If the formatted number doesn't have a decimal, add it
		if (!formatted.includes(decimalSeparator)) {
			formatted = formatted + decimalSeparator + decimalPart
		} else {
			// Replace the decimal part with what the user typed (including trailing zeros)
			const parts = formatted.split(decimalSeparator)
			formatted = parts[0] + decimalSeparator + decimalPart
		}
	}

	// Convert unformatted cursor position back to formatted position
	const newCursorPos = unformattedToFormattedPos(formatted, unformattedCursorPos, locale)

	return { formattedValue: formatted, newCursorPos }
}

// Update the bound value based on the formatted value
export function parseFormattedValue(
	formattedValue: string,
	locale: string | null | undefined,
): number | undefined {
	if (formattedValue === '' || formattedValue === '-') {
		// Empty string or just minus sign - return undefined
		return undefined
	}

	const numericValue = parseLocalizedNumber(formattedValue, locale)

	// Check if it's a valid number and not just 0 from invalid input
	if (
		!isNaN(numericValue) &&
		(numericValue !== 0 || formattedValue === '0' || formattedValue.match(/^0[.,]/))
	) {
		return numericValue
	}

	// For any other invalid input, return undefined
	return undefined
}

// Filter pasted text to remove invalid characters and limit decimal places
export function filterPastedText(
	pastedText: string,
	locale: string | null | undefined,
	min?: number,
	maximumFractionDigits: number = DEFAULT_MAXIMUM_FRACTION_DIGITS,
	currentValue?: string,
): string {
	let filteredText = pastedText
		.split('')
		.filter((char) => isValidChar(char, locale, min))
		.join('')

	// Smart decimal separator handling: if the current value already has a decimal separator,
	// remove any decimal separators from the pasted text to prevent double decimals
	if (currentValue && (currentValue.includes('.') || currentValue.includes(','))) {
		const { groupSeparator } = getLocaleSeparators(locale)
		// Remove both decimal separators AND group separators from pasted text
		// to prevent messy formatting when pasting into a field that already has decimals
		const separatorsRegex = new RegExp(`[.,\\${groupSeparator}]`, 'g')
		filteredText = filteredText.replace(separatorsRegex, '')
	}

	// Normalize leading zeros: if we're pasting only zeros, keep only one
	if (filteredText && /^0+$/.test(filteredText)) {
		filteredText = '0'
	}

	// Truncate to maximumFractionDigits decimal places if needed
	const decimalIndex = Math.max(filteredText.indexOf('.'), filteredText.indexOf(','))
	if (decimalIndex !== -1 && filteredText.length - decimalIndex - 1 > maximumFractionDigits) {
		filteredText = filteredText.slice(0, decimalIndex + maximumFractionDigits + 1)
	}

	return filteredText
}

// Check if we should prevent typing a character
export function shouldPreventChar(
	key: string,
	displayValue: string,
	locale: string | null | undefined,
	min?: number,
	cursorPos?: number,
	maximumFractionDigits: number = DEFAULT_MAXIMUM_FRACTION_DIGITS,
): boolean {
	// Check if the typed character is valid
	if (!isValidChar(key, locale, min)) {
		return true
	}

	// Prevent typing a second decimal separator
	if (key === '.' || key === ',') {
		const { decimalSeparator } = getLocaleSeparators(locale)
		const hasDecimalSeparator = displayValue.includes(decimalSeparator)
		if (hasDecimalSeparator) {
			return true
		}
	}

	// Prevent typing additional zeros if the field only contains zeros (prevents "0000")
	if (key === '0') {
		const unformattedValue = toUnformatted(displayValue, locale)
		if (/^0+$/.test(unformattedValue)) {
			return true
		}
	}

	// Prevent typing more digits if we're at the limit
	if (/[0-9]/.test(key)) {
		const { decimalSeparator } = getLocaleSeparators(locale)
		const decimalIndex = displayValue.indexOf(decimalSeparator)
		const unformattedValue = toUnformatted(displayValue, locale)

		if (decimalIndex !== -1) {
			// Has decimal separator
			const actualCursorPos = cursorPos ?? displayValue.length
			if (actualCursorPos > decimalIndex) {
				// Cursor is in decimal part - check if we're at max decimal digits
				const decimalPart = displayValue.slice(decimalIndex + 1)
				if (decimalPart.length >= maximumFractionDigits) {
					return true
				}
			} else {
				// Cursor is in integer part - check if we're at max integer digits
				const integerPart = unformattedValue.split(/[.,]/)[0]
				if (integerPart.length >= MAX_INTEGER_DIGITS) {
					return true
				}
			}
		} else {
			// No decimal separator - check if we're at max integer digits
			if (unformattedValue.length >= MAX_INTEGER_DIGITS) {
				return true
			}
		}
	}

	return false
}

// Validate if a value respects digit limits
export function validateDigitLimits(
	unformattedValue: string,
	locale: string | null | undefined,
	maximumFractionDigits: number = DEFAULT_MAXIMUM_FRACTION_DIGITS,
): boolean {
	// Split into integer and decimal parts
	const parts = unformattedValue.split(/[.,]/)
	const integerPart = parts[0] || ''
	const decimalPart = parts[1] || ''

	// Check integer digit limit (remove minus sign if present)
	if (integerPart.replace(/^-/, '').length > MAX_INTEGER_DIGITS) {
		return false
	}

	// Check decimal digit limit
	if (decimalPart.length > maximumFractionDigits) {
		return false
	}

	return true
}

// Apply min/max constraints, returning undefined for violations
export function applyConstraints(value: number, min?: number, max?: number): number | undefined {
	if (value === 0 && min !== undefined && min > 0) {
		// Special case: if value is 0 and there's a positive min constraint,
		// treat it as empty instead of constraining
		return undefined
	}

	// Check constraints and return undefined if violated
	if (min !== undefined && value < min) {
		return undefined
	}
	if (max !== undefined && value > max) {
		return undefined
	}

	// Value is within constraints
	return value
}
