import { test, expect } from '@playwright/experimental-ct-svelte'
import FormattedNumberInput from './input.svelte'

// Define test locales
const LOCALES = [
	{ code: 'en-US', thousandSep: ',', decimalSep: '.' },
	{ code: 'cs-CZ', thousandSep: '\u00A0', decimalSep: ',' },
] as const

// Helper to format expected values based on locale
function formatExpected(value: string, locale: (typeof LOCALES)[number]): string {
	// Replace placeholders with locale-specific separators
	return value.replace(/T/g, locale.thousandSep).replace(/D/g, locale.decimalSep)
}

// Helper to create input strings with locale-specific separators
function formatInput(value: string, locale: (typeof LOCALES)[number]): string {
	// Replace placeholders with locale-specific separators for input
	return value.replace(/T/g, locale.thousandSep).replace(/D/g, locale.decimalSep)
}

// Helper to prepare input for typing (focus + clear)
async function prepareInputForTyping(input: {
	focus(): Promise<void>
	clear(): Promise<void>
}): Promise<void> {
	await input.focus()
	await input.clear() // Ensure clean start
}

// Run tests for each locale
LOCALES.forEach((locale) => {
	test.describe(`FormattedNumberInput component (${locale.code})`, () => {
		test.describe('rendering and initial values', () => {
			test('should render with initial value and format it correctly', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 1234.56,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Verify the initial value is formatted correctly
				await expect(input).toHaveValue(formatExpected('1T234D56', locale))
			})

			test('should properly display default value when provided', async ({ mount }) => {
				// This test ensures that when editing a transaction, the existing amount value
				// is properly pre-populated in the input field
				const defaultValue = 5000
				const component = await mount(FormattedNumberInput, {
					props: {
						value: defaultValue,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// The input should display the formatted default value immediately
				await expect(input).toHaveValue(formatExpected('5T000', locale))

				// Focus should maintain the formatted value
				await input.focus()
				await expect(input).toHaveValue(formatExpected('5T000', locale))

				// After blur, the value should still be there
				await input.blur()
				await expect(input).toHaveValue(formatExpected('5T000', locale))
			})

			test('should update display value when prop changes dynamically', async ({ mount }) => {
				// This test simulates the edit transaction scenario where the value prop
				// changes after the component is mounted (e.g., when switching between transactions)
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Initially should be empty
				await expect(input).toHaveValue('')

				// Update the value prop to simulate editing a transaction
				await component.update({
					props: {
						value: 2500,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})

				// The input should now display the new value
				await expect(input).toHaveValue(formatExpected('2T500', locale))

				// Update again to simulate switching to another transaction
				await component.update({
					props: {
						value: 7890.12,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})

				// Should show the new value
				await expect(input).toHaveValue(formatExpected('7T890D12', locale))

				// Setting back to undefined should clear the input
				await component.update({
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})

				await expect(input).toHaveValue('')
			})

			test('should format digits as user types', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type digits one by one
				await input.pressSequentially('1234', { delay: 10 })

				// Should format with thousand separator
				await expect(input).toHaveValue(formatExpected('1T234', locale))
			})

			test('should handle decimal point input', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type decimal number - use appropriate decimal separator for locale
				await input.pressSequentially(formatInput('123D45', locale), { delay: 10 })

				await expect(input).toHaveValue(formatExpected('123D45', locale))
			})
		})

		test.describe('locale formatting', () => {
			test('should format large numbers correctly', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 1234567.89,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Should use appropriate separators for locale
				await expect(input).toHaveValue(formatExpected('1T234T567D89', locale))
			})
		})

		test.describe('validation and constraints', () => {
			test('should respect maximumFractionDigits constraint', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 123.456,
						locale: locale.code,
						maximumFractionDigits: 1,
					},
				})
				const input = component.locator('input')

				// Should render with truncated decimal places based on the prop
				await expect(input).toHaveValue(formatExpected('123D5', locale))
			})

			test('should preserve user input when below min constraint', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						min: 10,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()
				await input.fill('5')
				await input.blur()

				// Should preserve user input
				await expect(input).toHaveValue('5')
			})

			test('should preserve user input when above max constraint', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						max: 100,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()
				await input.fill('150')
				await input.blur()

				// Should preserve user input
				await expect(input).toHaveValue('150')
			})
		})

		test.describe('focus and selection', () => {
			test('should select all text when focusing on zero value', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 0,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Initial value should be '0'
				await expect(input).toHaveValue('0')

				// Focus on the input
				await input.focus()

				// Type a new value - should replace the selected zero
				await input.press('5')

				// Should have replaced the zero
				await expect(input).toHaveValue('5')
			})

			test('should handle focus and blur events', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 1234.5,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Initially formatted
				await expect(input).toHaveValue(formatExpected('1T234D5', locale))

				// Focus should maintain the value
				await input.focus()
				await expect(input).toHaveValue(formatExpected('1T234D5', locale))

				// Clear and type new value
				await input.clear()
				await input.type('5678')
				await expect(input).toHaveValue(formatExpected('5T678', locale))

				// Blur should maintain formatting
				await input.blur()
				await expect(input).toHaveValue(formatExpected('5T678', locale))
			})
		})

		test.describe('user input handling', () => {
			test('should allow typing trailing zeros in decimal places', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type number with trailing zeros
				await input.pressSequentially(formatInput('123D40', locale), { delay: 10 })

				// Should preserve trailing zeros while typing
				await expect(input).toHaveValue(formatExpected('123D40', locale))

				// After blur, trailing zeros should be preserved
				await input.blur()
				await expect(input).toHaveValue(formatExpected('123D4', locale))
			})

			test('should maintain empty field after deleting all content', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 123,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()

				// Clear the input completely
				await input.clear()

				// Should be empty
				await expect(input).toHaveValue('')

				// Should remain empty after blur
				await input.blur()
				await expect(input).toHaveValue('')
			})

			test('should ignore negative sign when min constraint is non-negative', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						min: 0,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()

				// Try to type negative number
				await input.type('-123')

				// Should ignore the minus sign
				await expect(input).toHaveValue('123')
			})

			test('should select zero value on focus', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 0,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Initial value should be '0'
				await expect(input).toHaveValue('0')

				// Focus on the input
				await input.focus()

				// Type a digit - should replace the selected '0'
				await input.press('7')

				// Should have replaced the zero
				await expect(input).toHaveValue('7')
			})

			test('should normalize multiple consecutive zeros', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()

				// Type multiple zeros
				await input.type('000')

				// Should normalize to single zero
				await expect(input).toHaveValue('0')
			})

			test('should handle pasting zeros into existing zero field', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 0,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()

				// Select the existing zero
				await input.press('Control+a')

				// Paste zeros
				await input.evaluate((el) => {
					const event = new ClipboardEvent('paste', {
						clipboardData: new DataTransfer(),
						bubbles: true,
						cancelable: true,
					})
					// @ts-expect-error - DataTransfer.setData is not in types
					event.clipboardData.setData('text/plain', '000')
					el.dispatchEvent(event)
				})

				// Should normalize to single zero
				await expect(input).toHaveValue('0')
			})

			test('should handle cursor positioning with thousand separators', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 123456,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Initial formatted value
				await expect(input).toHaveValue(formatExpected('123T456', locale))

				await input.focus()

				// Click to position cursor before '4' (after thousand separator)
				await input.click()
				await input.evaluate((el, sep) => {
					// Position cursor after the thousand separator
					const inputEl = el as HTMLInputElement
					const pos = inputEl.value.indexOf(sep) + sep.length
					inputEl.setSelectionRange(pos, pos)
				}, locale.thousandSep)

				// Type a digit
				await input.press('9')

				// The digit should be inserted correctly
				await expect(input).toHaveValue(formatExpected('1T239T456', locale))
			})

			test('should replace selected text when typing new digits', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 1234,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()
				await expect(input).toHaveValue(formatExpected('1T234', locale))

				// Select the "23" part
				await input.evaluate((el, sep) => {
					const inputEl = el as HTMLInputElement
					const value = inputEl.value
					const start = value.indexOf(sep) + sep.length
					const end = start + 2
					inputEl.setSelectionRange(start, end)
				}, locale.thousandSep)

				// Type to replace selection
				await input.press('9')

				await expect(input).toHaveValue(formatExpected('1T94', locale))
			})

			test('should delete selected text when pressing backspace', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 1234,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()
				await expect(input).toHaveValue(formatExpected('1T234', locale))

				// Select "234"
				await input.evaluate((el, sep) => {
					const inputEl = el as HTMLInputElement
					const value = inputEl.value
					const start = value.indexOf(sep) + sep.length
					inputEl.setSelectionRange(start, value.length)
				}, locale.thousandSep)

				// Press backspace to delete selection
				await input.press('Backspace')

				await expect(input).toHaveValue('1')
			})
		})

		test.describe('edge cases', () => {
			test('should allow typing more than 4 digits sequentially', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type 5 digits sequentially
				await input.pressSequentially('12345', { delay: 10 })

				// Should format correctly with thousand separator
				await expect(input).toHaveValue(formatExpected('12T345', locale))

				// Continue typing more digits
				await input.press('6')
				await expect(input).toHaveValue(formatExpected('123T456', locale))

				await input.press('7')
				await expect(input).toHaveValue(formatExpected('1T234T567', locale))
			})

			test('should allow typing decimal separator after 4 digits', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type 4 digits
				await input.pressSequentially('1234', { delay: 10 })
				await expect(input).toHaveValue(formatExpected('1T234', locale))

				// Type decimal separator appropriate for locale
				await input.press(locale.decimalSep)
				await expect(input).toHaveValue(formatExpected('1T234D', locale))

				// Continue with decimal digits
				await input.press('5')
				await expect(input).toHaveValue(formatExpected('1T234D5', locale))

				await input.press('6')
				await expect(input).toHaveValue(formatExpected('1T234D56', locale))
			})

			test('should prevent typing beyond maximum digits', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type maximum integer digits (15)
				await input.pressSequentially('123456789012345', { delay: 10 })
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345', locale))

				// Try to type one more digit - should be prevented
				await input.press('6')
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345', locale))

				// Should still allow decimal separator
				await input.press(locale.decimalSep)
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345D', locale))

				// And decimal digits
				await input.press('9')
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345D9', locale))
			})

			test('should prevent pasting when at maximum digit limit', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Type maximum integer digits
				await prepareInputForTyping(input)
				await input.pressSequentially('123456789012345', { delay: 10 })
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345', locale))

				// Try to paste more digits
				await input.evaluate((el) => {
					const event = new ClipboardEvent('paste', {
						clipboardData: new DataTransfer(),
						bubbles: true,
						cancelable: true,
					})
					// @ts-expect-error - DataTransfer.setData is not in types
					event.clipboardData.setData('text/plain', '999')
					el.dispatchEvent(event)
				})

				// Should remain unchanged
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345', locale))
			})

			test('should handle period as decimal separator in any locale', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type number with period as decimal separator
				await input.pressSequentially('123.45', { delay: 10 })

				// Should be formatted correctly for the locale
				await expect(input).toHaveValue(formatExpected('123D45', locale))
			})

			test('should handle comma as decimal separator in any locale', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type number with comma as decimal separator
				await input.pressSequentially('123,45', { delay: 10 })

				// For en-US, comma is thousand separator, so "123,45" becomes "12,345"
				// For cs-CZ, comma is decimal separator, so "123,45" becomes "123,45"
				const expectedValue =
					locale.code === 'en-US'
						? formatExpected('12T345', locale) // Comma interpreted as thousand separator
						: formatExpected('123D45', locale) // Comma interpreted as decimal separator
				await expect(input).toHaveValue(expectedValue)
			})

			test('should handle undefined value prop', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Should render with empty value
				await expect(input).toHaveValue('')
			})

			test('should handle negative numbers when min allows them', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						min: -100,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				await input.focus()
				await input.type('-50')

				await expect(input).toHaveValue('-50')
			})

			test('should prevent typing beyond maximum safe integer digits', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: undefined,
						locale: locale.code,
						maximumFractionDigits: 0,
					},
				})
				const input = component.locator('input')

				await prepareInputForTyping(input)

				// Type 15 digits (the maximum allowed)
				await input.pressSequentially('999999999999999', { delay: 10 })
				await expect(input).toHaveValue(formatExpected('999T999T999T999T999', locale))

				// Try to type one more digit - should be prevented
				await input.press('9')
				await expect(input).toHaveValue(formatExpected('999T999T999T999T999', locale))

				// Clear and try with leading 1
				await prepareInputForTyping(input)
				await input.pressSequentially('123456789012345', { delay: 10 })
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345', locale))

				// Should not allow more
				await input.press('6')
				await expect(input).toHaveValue(formatExpected('123T456T789T012T345', locale))
			})

			test('should format very large numbers correctly', async ({ mount }) => {
				const component = await mount(FormattedNumberInput, {
					props: {
						value: 999999999999999, // 15 digits - maximum safe
						locale: locale.code,
						maximumFractionDigits: 2,
					},
				})
				const input = component.locator('input')

				// Should format with all thousand separators
				await expect(input).toHaveValue(formatExpected('999T999T999T999T999', locale))
			})
		})
	})
})
