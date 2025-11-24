import { describe, it, expect } from 'vitest'
import { withInputStore } from './store.svelte'

describe('withInputStore', () => {
	describe('initialization', () => {
		it('should initialize with undefined value by default', () => {
			const store = withInputStore()
			expect(store.value).toBeUndefined()
			expect(store.displayValue).toBe('')
			expect(store.isFocused).toBe(false)
		})

		it('should initialize with provided value', () => {
			const store = withInputStore(123.45)
			expect(store.value).toBe(123.45)
			expect(store.displayValue).toBe('123.45')
			expect(store.isFocused).toBe(false)
		})

		it('should initialize with zero value', () => {
			const store = withInputStore(0)
			expect(store.value).toBe(0)
			expect(store.displayValue).toBe('0')
			expect(store.isFocused).toBe(false)
		})
	})

	describe('updateValue', () => {
		it('should parse and update valid formatted values (en-US)', () => {
			const store = withInputStore()

			store.updateValue('123', 'en-US')
			expect(store.value).toBe(123)

			store.updateValue('1,234.56', 'en-US')
			expect(store.value).toBe(1234.56)

			store.updateValue('-987.65', 'en-US')
			expect(store.value).toBe(-987.65)
		})

		it('should parse and update valid formatted values (cs-CZ)', () => {
			const store = withInputStore()

			store.updateValue('123', 'cs-CZ')
			expect(store.value).toBe(123)

			store.updateValue('1\u00A0234,56', 'cs-CZ')
			expect(store.value).toBe(1234.56)

			store.updateValue('-987,65', 'cs-CZ')
			expect(store.value).toBe(-987.65)
		})

		it('should set value to undefined for empty string', () => {
			const store = withInputStore(123)

			store.updateValue('', 'en-US')
			expect(store.value).toBeUndefined()
		})

		it('should not change value for minus sign only', () => {
			const store = withInputStore(123)

			store.updateValue('-', 'en-US')
			expect(store.value).toBe(123) // Should remain unchanged
		})

		it('should not change value for invalid input', () => {
			const store = withInputStore(123)

			store.updateValue('abc', 'en-US')
			expect(store.value).toBe(123) // Should remain unchanged
		})
	})

	describe('updateDisplayValue', () => {
		it('should update display value when not focused (en-US)', () => {
			const store = withInputStore()

			store.updateDisplayValue(1234.56, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('1,234.56')

			store.updateDisplayValue(0, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('0')

			store.updateDisplayValue(undefined, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('')
		})

		it('should update display value when not focused (cs-CZ)', () => {
			const store = withInputStore()

			store.updateDisplayValue(1234.56, 'cs-CZ', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('1\u00A0234,56')

			store.updateDisplayValue(0, 'cs-CZ', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('0')

			store.updateDisplayValue(undefined, 'cs-CZ', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('')
		})

		it('should respect maximumFractionDigits option', () => {
			const store = withInputStore()

			store.updateDisplayValue(123.456789, 'en-US', { maximumFractionDigits: 4 })
			expect(store.displayValue).toBe('123.4568')

			store.updateDisplayValue(123.456789, 'en-US', { maximumFractionDigits: 0 })
			expect(store.displayValue).toBe('123')

			store.updateDisplayValue(123.456789, 'en-US', { maximumFractionDigits: 1 })
			expect(store.displayValue).toBe('123.5')
		})

		it('should NOT update display value when focused', () => {
			const store = withInputStore()

			// Set focus
			store.setFocus(true)

			const originalDisplayValue = store.displayValue

			// Try to update display value - should be ignored
			store.updateDisplayValue(1234.56, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe(originalDisplayValue)
		})

		it('should update display value after losing focus', () => {
			const store = withInputStore()

			// Set focus and verify display value doesn't change
			store.setFocus(true)
			store.updateDisplayValue(1234.56, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('') // Should remain empty

			// Lose focus and try again
			store.setFocus(false)
			store.updateDisplayValue(1234.56, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('1,234.56')
		})
	})

	describe('setFocus', () => {
		it('should update focus state', () => {
			const store = withInputStore()

			expect(store.isFocused).toBe(false)

			store.setFocus(true)
			expect(store.isFocused).toBe(true)

			store.setFocus(false)
			expect(store.isFocused).toBe(false)
		})
	})

	describe('reactivity integration', () => {
		it('should work with multiple operations', () => {
			const store = withInputStore()

			// Simulate user interaction flow
			store.setFocus(true)
			expect(store.isFocused).toBe(true)

			// User types a value
			store.updateValue('123.45', 'en-US')
			expect(store.value).toBe(123.45)

			// Display value shouldn't update while focused
			store.updateDisplayValue(123.45, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('') // Should remain empty

			// User loses focus
			store.setFocus(false)
			expect(store.isFocused).toBe(false)

			// Now display value should update
			store.updateDisplayValue(123.45, 'en-US', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('123.45')
		})

		it('should handle complex locale-specific workflow (cs-CZ)', () => {
			const store = withInputStore(0)

			store.setFocus(true)

			// User enters Czech-formatted number
			store.updateValue('1\u00A0234,56', 'cs-CZ')
			expect(store.value).toBe(1234.56)

			// Blur with formatting
			store.setFocus(false)
			store.updateDisplayValue(1234.56, 'cs-CZ', { maximumFractionDigits: 2 })
			expect(store.displayValue).toBe('1\u00A0234,56')
		})
	})
})
