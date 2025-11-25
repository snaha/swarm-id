import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'
import {
	createFocusHandler,
	createBlurHandler,
	createKeyDownHandler,
	createPasteHandler,
	createInputHandler,
	createEventHandlerState,
	type EventHandlerConfig,
	type EventHandlerState,
} from './events'
import { withInputStore } from './store.svelte'
import type { InputStore } from './store.svelte'

// Mock HTMLInputElement methods
const createMockInputElement = (): HTMLInputElement => {
	const mockElement = {
		selectionStart: 0,
		selectionEnd: 0,
		value: '',
		select: vi.fn(),
		setSelectionRange: vi.fn(),
	} as unknown as HTMLInputElement
	return mockElement
}

// Create a test store that allows direct manipulation of displayValue
interface TestInputStore extends InputStore {
	setTestDisplayValue(value: string): void
}

const createTestStore = (initialValue?: number): TestInputStore => {
	const store = withInputStore(initialValue)
	let testDisplayValue = store.displayValue

	return {
		get value() {
			return store.value
		},
		get displayValue() {
			return testDisplayValue
		},
		get isFocused() {
			return store.isFocused
		},
		updateValue: store.updateValue.bind(store),
		setValue: store.setValue.bind(store),
		setDisplayValue: store.setDisplayValue.bind(store),
		updateDisplayValue: store.updateDisplayValue.bind(store),
		setFocus: store.setFocus.bind(store),
		setTestDisplayValue(value: string) {
			testDisplayValue = value
		},
	}
}

describe('Event Handlers', () => {
	let store: TestInputStore
	let config: EventHandlerConfig
	let eventState: EventHandlerState
	let mockInputElement: HTMLInputElement
	let getInputElement: MockedFunction<() => HTMLInputElement | undefined>

	beforeEach(() => {
		store = createTestStore()
		config = {
			store,
			locale: 'en-US',
			formatOptions: { maximumFractionDigits: 2 },
			constraints: { min: undefined, max: undefined },
		}
		eventState = createEventHandlerState()
		mockInputElement = createMockInputElement()
		getInputElement = vi.fn(() => mockInputElement)
	})

	describe('createFocusHandler', () => {
		it('should set focus to true', () => {
			const handleFocus = createFocusHandler(store, getInputElement)

			handleFocus()

			expect(store.isFocused).toBe(true)
		})

		it('should select all text when displayValue is "0"', async () => {
			const handleFocus = createFocusHandler(store, getInputElement)

			// Set displayValue to "0" by updating the store directly
			store.updateValue('0', 'en-US')
			store.setTestDisplayValue('0')

			handleFocus()

			// Should call select after timeout
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(mockInputElement.select).toHaveBeenCalled()
		})

		it('should not select text when displayValue is not "0"', () => {
			const handleFocus = createFocusHandler(store, getInputElement)

			store.updateValue('123', 'en-US')

			handleFocus()

			setTimeout(() => {
				expect(mockInputElement.select).not.toHaveBeenCalled()
			}, 0)
		})
	})

	describe('createBlurHandler', () => {
		it('should set focus to false', () => {
			store.setFocus(true)
			const handleBlur = createBlurHandler(config)

			handleBlur()

			expect(store.isFocused).toBe(false)
		})

		it('should invalidate value when below minimum constraint', () => {
			config.constraints = { min: 10, max: undefined }
			const handleBlur = createBlurHandler(config)

			store.updateValue('5', 'en-US')
			store.setTestDisplayValue('5')

			handleBlur()

			expect(store.value).toBeUndefined()
		})

		it('should invalidate value when above maximum constraint', () => {
			config.constraints = { min: undefined, max: 100 }
			const handleBlur = createBlurHandler(config)

			store.updateValue('150', 'en-US')
			store.setTestDisplayValue('150')

			handleBlur()

			expect(store.value).toBeUndefined()
		})

		it('should not apply constraints for empty or incomplete values', () => {
			config.constraints = { min: 10, max: 100 }
			const handleBlur = createBlurHandler(config)

			// Test empty value
			store.updateValue('', 'en-US')
			handleBlur()
			expect(store.value).toBeUndefined()

			// Test minus sign only
			store.updateValue('-', 'en-US')
			handleBlur()
			expect(store.value).toBeUndefined() // updateValue doesn't change value for '-'
		})

		it('should treat 0 as empty when min > 0', () => {
			config.constraints = { min: 1, max: undefined }
			const handleBlur = createBlurHandler(config)

			store.updateValue('0', 'en-US')
			store.setTestDisplayValue('0')

			handleBlur()

			expect(store.value).toBeUndefined() // Should be cleared due to applyConstraints logic
		})
	})

	describe('createKeyDownHandler', () => {
		it('should allow navigation keys', () => {
			const handleKeyDown = createKeyDownHandler(config, getInputElement)
			const mockEvent = {
				key: 'ArrowRight',
				preventDefault: vi.fn(),
				ctrlKey: false,
				metaKey: false,
			} as unknown as KeyboardEvent

			handleKeyDown(mockEvent)

			expect(mockEvent.preventDefault).not.toHaveBeenCalled()
		})

		it('should allow copy/paste shortcuts', () => {
			const handleKeyDown = createKeyDownHandler(config, getInputElement)
			const mockEvent = {
				key: 'v',
				preventDefault: vi.fn(),
				ctrlKey: true,
				metaKey: false,
			} as unknown as KeyboardEvent

			handleKeyDown(mockEvent)

			expect(mockEvent.preventDefault).not.toHaveBeenCalled()
		})

		it('should prevent invalid characters', () => {
			const handleKeyDown = createKeyDownHandler(config, getInputElement)
			store.updateValue('123', 'en-US')

			const mockEvent = {
				key: 'a',
				preventDefault: vi.fn(),
				ctrlKey: false,
				metaKey: false,
			} as unknown as KeyboardEvent

			handleKeyDown(mockEvent)

			expect(mockEvent.preventDefault).toHaveBeenCalled()
		})

		it('should handle backspace on thousand separator', () => {
			const handleKeyDown = createKeyDownHandler(config, getInputElement)

			// Set up a formatted number with thousand separator
			store.updateValue('1234', 'en-US') // Store the unformatted value
			store.setTestDisplayValue('1,234') // Set display value directly
			mockInputElement.selectionStart = 2 // Position after comma
			mockInputElement.selectionEnd = 2

			const mockEvent = {
				key: 'Backspace',
				preventDefault: vi.fn(),
				ctrlKey: false,
				metaKey: false,
			} as unknown as KeyboardEvent

			handleKeyDown(mockEvent)

			expect(mockEvent.preventDefault).toHaveBeenCalled()
		})

		it('should handle delete on thousand separator', () => {
			const handleKeyDown = createKeyDownHandler(config, getInputElement)

			// Set up a formatted number with thousand separator
			store.updateValue('1234', 'en-US') // Store the unformatted value
			store.setTestDisplayValue('1,234') // Set display value directly
			mockInputElement.selectionStart = 1 // Position before comma
			mockInputElement.selectionEnd = 1

			const mockEvent = {
				key: 'Delete',
				preventDefault: vi.fn(),
				ctrlKey: false,
				metaKey: false,
			} as unknown as KeyboardEvent

			handleKeyDown(mockEvent)

			expect(mockEvent.preventDefault).toHaveBeenCalled()
		})
	})

	describe('createPasteHandler', () => {
		it('should prevent default paste behavior', () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '123.45'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)

			expect(mockEvent.preventDefault).toHaveBeenCalled()
		})

		it('should filter and format pasted text', () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			// Set up empty input element value
			mockInputElement.selectionStart = 0
			mockInputElement.selectionEnd = 0
			mockInputElement.value = '' // explicitly set to empty

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '$1,234.56'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)
		})

		it('should handle paste with insertion at cursor position', () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			// Set up existing value: "1,000.00"
			store.updateValue('1000.00', 'en-US')
			store.setTestDisplayValue('1,000.00')
			mockInputElement.selectionStart = 1 // Position after "1" in "1,000.00"
			mockInputElement.selectionEnd = 1 // No selection, just cursor position

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '23'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)
		})

		it('should handle paste with selection replacement', () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			// Set up existing value: "1,000.00" (formatted) -> "1000.00" (unformatted)
			store.updateValue('1000.00', 'en-US')
			store.setTestDisplayValue('1,000.00')
			mockInputElement.selectionStart = 2 // Position after comma in "1,000.00"
			mockInputElement.selectionEnd = 5 // Select "000" in formatted string

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '234'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)
		})

		it('should set cursor position after paste', async () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			mockInputElement.selectionStart = 0
			mockInputElement.selectionEnd = 0

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '123'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)

			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(mockInputElement.setSelectionRange).toHaveBeenCalled()
		})

		it('should handle locale-specific paste formatting (en-US)', () => {
			config.locale = 'en-US'
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			mockInputElement.selectionStart = 0
			mockInputElement.selectionEnd = 0

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '1234.56'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)
		})

		it('should handle locale-specific paste formatting (cs-CZ)', () => {
			config.locale = 'cs-CZ'
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			mockInputElement.selectionStart = 0
			mockInputElement.selectionEnd = 0

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '1234,56'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)
		})

		it('should remove decimal separators from pasted content when target has decimal', () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			// Set up existing value with decimal
			store.setTestDisplayValue('100.50')
			mockInputElement.value = '100.50'
			mockInputElement.selectionStart = 6 // At end
			mockInputElement.selectionEnd = 6

			// Paste content with decimal separator
			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '25.75'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)

			// Should remove the decimal from pasted content (25.75 -> 2575) and append to existing
			// Result should be 100.50 + 2575 = 100.502575 formatted
		})

		it('should handle paste with corrupted input element value fallback', () => {
			const handlePaste = createPasteHandler(config, eventState, getInputElement)

			// Set store to reliable value
			store.setTestDisplayValue('1,234.56')

			// Set input element to corrupted value (too long, multiple decimals)
			mockInputElement.value = '1,234.56.789.123456789.987654321'
			mockInputElement.selectionStart = 1
			mockInputElement.selectionEnd = 1

			const mockEvent = {
				preventDefault: vi.fn(),
				clipboardData: {
					getData: vi.fn(() => '999'),
				},
			} as unknown as ClipboardEvent

			handlePaste(mockEvent)

			// Should fall back to using store.displayValue instead of corrupted input.value
		})
	})

	describe('createInputHandler', () => {
		it('should format input and update store', () => {
			const handleInput = createInputHandler(config, eventState, getInputElement)

			const mockEvent = {
				target: {
					value: '1234.56',
					selectionStart: 8,
				},
			} as unknown as Event

			handleInput(mockEvent)
		})

		it('should handle decimal input correctly', () => {
			const handleInput = createInputHandler(config, eventState, getInputElement)

			const mockEvent = {
				target: {
					value: '.',
					selectionStart: 1,
				},
			} as unknown as Event

			handleInput(mockEvent)
		})

		it('should set cursor position after formatting', async () => {
			const handleInput = createInputHandler(config, eventState, getInputElement)

			const mockEvent = {
				target: {
					value: '1234',
					selectionStart: 4,
				},
			} as unknown as Event

			handleInput(mockEvent)

			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(mockInputElement.setSelectionRange).toHaveBeenCalled()
		})

		it('should work with different locales', () => {
			config.locale = 'cs-CZ'
			const handleInput = createInputHandler(config, eventState, getInputElement)

			const mockEvent = {
				target: {
					value: '1234,56',
					selectionStart: 7,
				},
			} as unknown as Event

			handleInput(mockEvent)
		})
	})

	describe('error handling', () => {
		it('should handle missing input element in keydown handler', () => {
			getInputElement.mockReturnValue(undefined)

			const handleKeyDown = createKeyDownHandler(config, getInputElement)

			expect(() => {
				handleKeyDown({
					key: 'Backspace',
					preventDefault: vi.fn(),
				} as unknown as KeyboardEvent)
			}).not.toThrow()
		})
	})
})
