export function formatNumber(
	value: number,
	locale: string | null | undefined,
	options?: Intl.NumberFormatOptions,
) {
	const intl = new Intl.NumberFormat(locale || undefined, {
		style: 'decimal',
		...options,
	})
	return intl.format(value)
}

export function parseLocalizedNumber(value: string, locale: string | null | undefined): number {
	// Get the thousand separator for the locale
	const formatter = new Intl.NumberFormat(locale || undefined)
	const parts = formatter.formatToParts(1234.5)
	const groupSeparator = parts.find((part) => part.type === 'group')?.value || ','

	// Remove all thousand separators
	let normalized = value.replace(new RegExp(`\\${groupSeparator}`, 'g'), '')

	// Handle both . and , as decimal separators intelligently
	// If there's only one decimal separator (either . or ,), treat it as decimal
	const dotCount = (normalized.match(/\./g) || []).length
	const commaCount = (normalized.match(/,/g) || []).length

	if (dotCount === 1 && commaCount === 0) {
		// Only dots, keep as is
	} else if (commaCount === 1 && dotCount === 0) {
		// Only comma, convert to dot
		normalized = normalized.replace(',', '.')
	} else if (dotCount > 1 || commaCount > 1 || (dotCount > 0 && commaCount > 0)) {
		// Multiple separators or mixed - invalid, return 0
		return 0
	}

	return parseFloat(normalized) || 0
}
