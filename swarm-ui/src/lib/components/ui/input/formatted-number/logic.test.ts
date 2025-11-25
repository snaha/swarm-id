import { describe, it, expect } from 'vitest'
import {
	DEFAULT_MAXIMUM_FRACTION_DIGITS,
	getLocaleSeparators,
	isValidChar,
	toUnformatted,
	formattedToUnformattedPos,
	unformattedToFormattedPos,
	applyLiveFormatting,
	parseFormattedValue,
	filterPastedText,
	shouldPreventChar,
	applyConstraints,
} from './logic'

describe('DEFAULT_MAXIMUM_FRACTION_DIGITS', () => {
	it('should have the correct default value', () => {
		expect(DEFAULT_MAXIMUM_FRACTION_DIGITS).toBe(2)
	})
})

describe('getLocaleSeparators', () => {
	it('should return correct separators for en-US locale', () => {
		const result = getLocaleSeparators('en-US')
		expect(result.decimalSeparator).toBe('.')
		expect(result.groupSeparator).toBe(',')
	})

	it('should return correct separators for de-DE locale', () => {
		const result = getLocaleSeparators('de-DE')
		expect(result.decimalSeparator).toBe(',')
		expect(result.groupSeparator).toBe('.')
	})

	it('should return correct separators for cs-CZ locale', () => {
		const result = getLocaleSeparators('cs-CZ')
		expect(result.decimalSeparator).toBe(',')
		// Czech uses non-breaking space for thousands
		expect(result.groupSeparator).toBe('\u00A0')
	})

	it('should handle undefined locale', () => {
		const result = getLocaleSeparators(undefined)
		expect(result.decimalSeparator).toBeDefined()
		expect(result.groupSeparator).toBeDefined()
	})
})

describe('isValidChar', () => {
	it('should allow digits (en-US and cs-CZ)', () => {
		expect(isValidChar('0', 'en-US')).toBe(true)
		expect(isValidChar('5', 'en-US')).toBe(true)
		expect(isValidChar('9', 'en-US')).toBe(true)
	})

	it('should allow decimal separators (en-US and cs-CZ)', () => {
		expect(isValidChar('.', 'en-US')).toBe(true)
		expect(isValidChar(',', 'en-US')).toBe(true)
	})

	it('should allow group separator (en-US, de-DE, cs-CZ)', () => {
		expect(isValidChar(',', 'en-US')).toBe(true)
		expect(isValidChar('.', 'de-DE')).toBe(true)
		expect(isValidChar('\u00A0', 'cs-CZ')).toBe(true)
	})

	it('should handle minus sign based on min constraint (en-US and cs-CZ)', () => {
		expect(isValidChar('-', 'en-US', undefined)).toBe(true)
		expect(isValidChar('-', 'en-US', -10)).toBe(true)
		expect(isValidChar('-', 'en-US', 0)).toBe(false)
		expect(isValidChar('-', 'en-US', 1)).toBe(false)
	})

	it('should reject invalid characters (en-US and cs-CZ)', () => {
		expect(isValidChar('a', 'en-US')).toBe(false)
		expect(isValidChar('$', 'en-US')).toBe(false)
		expect(isValidChar(' ', 'en-US')).toBe(false)
	})
})

describe('toUnformatted', () => {
	it('should remove thousand separators (en-US, de-DE, cs-CZ)', () => {
		expect(toUnformatted('1,234,567.89', 'en-US')).toBe('1234567.89')
		expect(toUnformatted('1.234.567,89', 'de-DE')).toBe('1234567,89')
		expect(toUnformatted('1\u00A0234\u00A0567,89', 'cs-CZ')).toBe('1234567,89')
	})

	it('should handle numbers without separators (en-US and cs-CZ)', () => {
		expect(toUnformatted('123.45', 'en-US')).toBe('123.45')
		expect(toUnformatted('123', 'en-US')).toBe('123')
		expect(toUnformatted('123,45', 'cs-CZ')).toBe('123,45')
		expect(toUnformatted('123', 'cs-CZ')).toBe('123')
	})
})

describe('formattedToUnformattedPos', () => {
	it('should convert cursor position correctly (en-US)', () => {
		// "1,234" -> "1234"
		expect(formattedToUnformattedPos('1,234', 0, 'en-US')).toBe(0) // Before 1
		expect(formattedToUnformattedPos('1,234', 1, 'en-US')).toBe(1) // After 1
		expect(formattedToUnformattedPos('1,234', 2, 'en-US')).toBe(1) // After comma (still position 1 in unformatted)
		expect(formattedToUnformattedPos('1,234', 3, 'en-US')).toBe(2) // After 2
		expect(formattedToUnformattedPos('1,234', 5, 'en-US')).toBe(4) // After 4
	})

	it('should convert cursor position correctly (cs-CZ)', () => {
		// "1\u00A0234" -> "1234"
		expect(formattedToUnformattedPos('1\u00A0234', 0, 'cs-CZ')).toBe(0) // Before 1
		expect(formattedToUnformattedPos('1\u00A0234', 1, 'cs-CZ')).toBe(1) // After 1
		expect(formattedToUnformattedPos('1\u00A0234', 2, 'cs-CZ')).toBe(1) // After space (still position 1 in unformatted)
		expect(formattedToUnformattedPos('1\u00A0234', 3, 'cs-CZ')).toBe(2) // After 2
		expect(formattedToUnformattedPos('1\u00A0234', 5, 'cs-CZ')).toBe(4) // After 4
	})
})

describe('unformattedToFormattedPos', () => {
	it('should convert cursor position correctly (en-US)', () => {
		// "1234" -> "1,234"
		expect(unformattedToFormattedPos('1,234', 0, 'en-US')).toBe(0) // Before 1
		expect(unformattedToFormattedPos('1,234', 1, 'en-US')).toBe(1) // After 1
		expect(unformattedToFormattedPos('1,234', 2, 'en-US')).toBe(3) // After 2 (skipping comma)
		expect(unformattedToFormattedPos('1,234', 4, 'en-US')).toBe(5) // After 4
	})

	it('should convert cursor position correctly (cs-CZ)', () => {
		// "1234" -> "1\u00A0234"
		expect(unformattedToFormattedPos('1\u00A0234', 0, 'cs-CZ')).toBe(0) // Before 1
		expect(unformattedToFormattedPos('1\u00A0234', 1, 'cs-CZ')).toBe(1) // After 1
		expect(unformattedToFormattedPos('1\u00A0234', 2, 'cs-CZ')).toBe(3) // After 2 (skipping space)
		expect(unformattedToFormattedPos('1\u00A0234', 4, 'cs-CZ')).toBe(5) // After 4
	})
})

describe('applyLiveFormatting', () => {
	it('should handle empty input', () => {
		const result = applyLiveFormatting('', 0, 'en-US')
		expect(result.formattedValue).toBe('')
		expect(result.newCursorPos).toBe(0)
	})

	it('should handle minus sign only', () => {
		const result = applyLiveFormatting('-', 1, 'en-US')
		expect(result.formattedValue).toBe('-')
		expect(result.newCursorPos).toBe(1)
	})

	it('should handle decimal separator only', () => {
		const result = applyLiveFormatting('.', 1, 'en-US')
		expect(result.formattedValue).toBe('0.')
		expect(result.newCursorPos).toBe(2)

		const resultComma = applyLiveFormatting(',', 1, 'de-DE')
		expect(resultComma.formattedValue).toBe('0,')
		expect(resultComma.newCursorPos).toBe(2)

		const resultCzech = applyLiveFormatting(',', 1, 'cs-CZ')
		expect(resultCzech.formattedValue).toBe('0,')
		expect(resultCzech.newCursorPos).toBe(2)
	})

	it('should format numbers with thousand separators', () => {
		const result = applyLiveFormatting('1234567', 7, 'en-US')
		expect(result.formattedValue).toBe('1,234,567')
		expect(result.newCursorPos).toBe(9)

		const resultCzech = applyLiveFormatting('1234567', 7, 'cs-CZ')
		expect(resultCzech.formattedValue).toBe('1\u00A0234\u00A0567')
		expect(resultCzech.newCursorPos).toBe(9)
	})

	it('should preserve trailing zeros after decimal', () => {
		const result = applyLiveFormatting('1.50', 4, 'en-US')
		expect(result.formattedValue).toBe('1.50')
		expect(result.newCursorPos).toBe(4)

		const resultCzech = applyLiveFormatting('1,50', 4, 'cs-CZ')
		expect(resultCzech.formattedValue).toBe('1,50')
		expect(resultCzech.newCursorPos).toBe(4)
	})

	it('should preserve decimal point when typing', () => {
		const result = applyLiveFormatting('123.', 4, 'en-US')
		expect(result.formattedValue).toBe('123.')
		expect(result.newCursorPos).toBe(4)

		const resultCzech = applyLiveFormatting('123,', 4, 'cs-CZ')
		expect(resultCzech.formattedValue).toBe('123,')
		expect(resultCzech.newCursorPos).toBe(4)
	})

	it('should handle trailing zeros correctly', () => {
		const result = applyLiveFormatting('1.05', 4, 'en-US')
		expect(result.formattedValue).toBe('1.05')
		expect(result.newCursorPos).toBe(4)

		const resultCzech = applyLiveFormatting('1,05', 4, 'cs-CZ')
		expect(resultCzech.formattedValue).toBe('1,05')
		expect(resultCzech.newCursorPos).toBe(4)
	})

	it('should respect custom maximumFractionDigits', () => {
		// Test with 4 decimal places
		const result = applyLiveFormatting('123.45678', 9, 'en-US', 4)
		expect(result.formattedValue).toBe('123.4568')

		// Test with 0 decimal places
		const resultZero = applyLiveFormatting('123.45', 6, 'en-US', 0)
		expect(resultZero.formattedValue).toBe('123')

		// Test with 1 decimal place
		const resultOne = applyLiveFormatting('123.45', 6, 'en-US', 1)
		expect(resultOne.formattedValue).toBe('123.5')
	})

	it('should use default maximumFractionDigits when not specified', () => {
		const result = applyLiveFormatting('123.456789', 10, 'en-US')
		expect(result.formattedValue).toBe('123.46')
		expect(result.newCursorPos).toBe(6)
	})
})

describe('parseFormattedValue', () => {
	it('should parse valid numbers', () => {
		expect(parseFormattedValue('123', 'en-US')).toBe(123)
		expect(parseFormattedValue('1,234.56', 'en-US')).toBe(1234.56)
		expect(parseFormattedValue('1.234,56', 'de-DE')).toBe(1234.56)
		expect(parseFormattedValue('1\u00A0234,56', 'cs-CZ')).toBe(1234.56)
	})

	it('should return undefined for empty string', () => {
		expect(parseFormattedValue('', 'en-US')).toBeUndefined()
	})

	it('should return undefined for minus sign only', () => {
		expect(parseFormattedValue('-', 'en-US')).toBeUndefined()
	})

	it('should return undefined for invalid input', () => {
		expect(parseFormattedValue('abc', 'en-US')).toBeUndefined()
	})
})

describe('filterPastedText', () => {
	it('should filter out invalid characters', () => {
		expect(filterPastedText('123abc456', 'en-US')).toBe('123456')
		expect(filterPastedText('$1,234.56', 'en-US')).toBe('1,234.56')
		expect(filterPastedText('€1\u00A0234,56', 'cs-CZ')).toBe('1\u00A0234,56')
	})

	it('should respect min constraint for minus sign', () => {
		expect(filterPastedText('-123', 'en-US', 0)).toBe('123')
		expect(filterPastedText('-123', 'en-US', -10)).toBe('-123')
	})

	it('should limit decimal places', () => {
		expect(filterPastedText('123.4567890123', 'en-US')).toBe('123.45')
		expect(filterPastedText('0.1234567', 'en-US')).toBe('0.12')
		expect(filterPastedText('123,4567890123', 'cs-CZ')).toBe('123,45')
		expect(filterPastedText('0,1234567', 'cs-CZ')).toBe('0,12')
	})

	it('should respect custom maximumFractionDigits in filterPastedText', () => {
		expect(filterPastedText('123.4567890123', 'en-US', undefined, 4)).toBe('123.4567')
		expect(filterPastedText('0.1234567', 'en-US', undefined, 1)).toBe('0.1')
		expect(filterPastedText('123,4567890123', 'cs-CZ', undefined, 0)).toBe('123,')
		expect(filterPastedText('0,1234567', 'cs-CZ', undefined, 3)).toBe('0,123')
	})

	it('should remove decimal separators when current value already has one', () => {
		// This tests the specific bug: self-insertion should filter out decimal separators

		// US format: paste "1,111.42" into field that already has "1,111.42"
		const result1 = filterPastedText('1,111.42', 'en-US', undefined, 2, '1,111.42')
		expect(result1).toBe('111142') // Should remove all separators including decimal

		// Czech format: paste "1 111,42" into field that already has "1 111,42"
		const result2 = filterPastedText('1\u00A0111,42', 'cs-CZ', undefined, 2, '1\u00A0111,42')
		expect(result2).toBe('111142') // Should remove all separators including decimal

		// Test with just decimal separators
		expect(filterPastedText('.42', 'en-US', undefined, 2, '123.45')).toBe('42')
		expect(filterPastedText(',42', 'cs-CZ', undefined, 2, '123,45')).toBe('42')
	})
})

describe('shouldPreventChar', () => {
	it('should prevent invalid characters', () => {
		expect(shouldPreventChar('a', '123', 'en-US')).toBe(true)
		expect(shouldPreventChar('$', '123', 'en-US')).toBe(true)
		expect(shouldPreventChar('a', '123', 'cs-CZ')).toBe(true)
		expect(shouldPreventChar('€', '123', 'cs-CZ')).toBe(true)
	})

	it('should allow valid characters', () => {
		expect(shouldPreventChar('5', '123', 'en-US')).toBe(false)
		expect(shouldPreventChar('.', '123', 'en-US')).toBe(false)
		expect(shouldPreventChar('5', '123', 'cs-CZ')).toBe(false)
		expect(shouldPreventChar(',', '123', 'cs-CZ')).toBe(false)
	})

	it('should prevent second decimal separator', () => {
		expect(shouldPreventChar('.', '123.45', 'en-US')).toBe(true)
		expect(shouldPreventChar(',', '123.45', 'en-US')).toBe(true)
		expect(shouldPreventChar(',', '123,45', 'cs-CZ')).toBe(true)
		expect(shouldPreventChar('.', '123,45', 'cs-CZ')).toBe(true)
	})

	it('should prevent exceeding max decimal places', () => {
		expect(shouldPreventChar('3', '123.45', 'en-US')).toBe(true)
		expect(shouldPreventChar('2', '123.4', 'en-US')).toBe(false)
		expect(shouldPreventChar('3', '123,45', 'cs-CZ')).toBe(true)
		expect(shouldPreventChar('2', '123,4', 'cs-CZ')).toBe(false)
	})

	it('should respect custom maximumFractionDigits in shouldPreventChar', () => {
		// With 4 decimal places, should prevent typing when already at max
		expect(shouldPreventChar('6', '123.4567', 'en-US', undefined, 8, 4)).toBe(true) // cursor at end, already 4 decimal places
		expect(shouldPreventChar('8', '123.456', 'en-US', undefined, 7, 4)).toBe(false) // cursor at end, only 3 decimal places

		// With 0 decimal places, should prevent all decimal digits
		expect(shouldPreventChar('1', '123.', 'en-US', undefined, 4, 0)).toBe(true)

		// With 1 decimal place
		expect(shouldPreventChar('5', '123.4', 'en-US', undefined, 5, 1)).toBe(true) // already at max
		expect(shouldPreventChar('5', '123.', 'en-US', undefined, 4, 1)).toBe(false) // can add 1 decimal place
	})

	it('should handle long numbers with max decimal places correctly (en-US)', () => {
		// This should allow typing in the integer part even when decimal part is at max
		const displayValue = '1,234,567,890.12'
		const decimalIndex = displayValue.indexOf('.')

		// Adding to integer part should be allowed (cursor before decimal point)
		expect(shouldPreventChar('6', displayValue, 'en-US', undefined, 5)).toBe(false) // cursor in integer part
		expect(shouldPreventChar('6', displayValue, 'en-US', undefined, decimalIndex - 1)).toBe(false) // cursor at end of integer part

		// Adding to decimal part when at max should be prevented (cursor after decimal point)
		expect(shouldPreventChar('3', displayValue, 'en-US', undefined, displayValue.length)).toBe(true) // cursor at end of decimal part
		expect(shouldPreventChar('3', displayValue, 'en-US', undefined, decimalIndex + 2)).toBe(true) // cursor in middle of decimal part
	})

	it('should respect min constraint for minus sign', () => {
		expect(shouldPreventChar('-', '123', 'en-US', 0)).toBe(true)
		expect(shouldPreventChar('-', '123', 'en-US', -10)).toBe(false)
	})
})

describe('applyConstraints', () => {
	it('should invalidate value when below min constraint', () => {
		expect(applyConstraints(5, 10, undefined)).toBeUndefined()
		expect(applyConstraints(15, 10, undefined)).toBe(15)
	})

	it('should invalidate value when above max constraint', () => {
		expect(applyConstraints(15, undefined, 10)).toBeUndefined()
		expect(applyConstraints(5, undefined, 10)).toBe(5)
	})

	it('should invalidate value when outside both constraints', () => {
		expect(applyConstraints(5, 10, 20)).toBeUndefined()
		expect(applyConstraints(25, 10, 20)).toBeUndefined()
		expect(applyConstraints(15, 10, 20)).toBe(15)
	})

	it('should treat 0 as empty when min > 0', () => {
		expect(applyConstraints(0, 1, undefined)).toBeUndefined()
		expect(applyConstraints(0, 0, undefined)).toBe(0)
		expect(applyConstraints(0, -5, undefined)).toBe(0)
	})
})
