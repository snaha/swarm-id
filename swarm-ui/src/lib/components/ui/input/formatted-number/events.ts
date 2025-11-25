import {
	getLocaleSeparators,
	toUnformatted,
	formattedToUnformattedPos,
	applyLiveFormatting,
	filterPastedText,
	shouldPreventChar,
	applyConstraints,
	isValidChar,
	validateDigitLimits,
} from './logic'
import { parseLocalizedNumber } from '$lib/utils/format'
import type { InputStore, FormatOptions } from './store.svelte'

export interface EventHandlerConfig {
	store: InputStore
	locale: string | null | undefined
	formatOptions: FormatOptions
	constraints?: {
		min?: number
		max?: number
	}
}

export interface EventHandlerState {
	isPasteInProgress: boolean
}

export function createEventHandlerState(): EventHandlerState {
	return {
		isPasteInProgress: false,
	}
}

/**
 * Sets cursor position with cross-browser compatibility.
 * Uses immediate setting plus delayed retry for better reliability across browsers.
 */
function setCursorPosition(inputElement: HTMLInputElement | undefined, position: number): void {
	if (!inputElement) return

	try {
		inputElement.setSelectionRange(position, position)
		// Retry after DOM update to handle browser-specific timing issues
		setTimeout(() => {
			try {
				inputElement.setSelectionRange(position, position)
			} catch {
				// Silently ignore errors - some browsers may not support setSelectionRange
			}
		}, 0)
	} catch {
		// Silently ignore errors - fallback for unsupported browsers
	}
}

/**
 * Common helper to update display value, store value, and cursor position.
 * Consolidates the three-step update pattern used throughout the component.
 */
function updateValues(
	formattedValue: string,
	newCursorPos: number,
	inputElement: HTMLInputElement | undefined,
	config: EventHandlerConfig,
): void {
	config.store.setDisplayValue(formattedValue)
	config.store.updateValue(formattedValue, config.locale)
	setCursorPosition(inputElement, newCursorPos)
}

/**
 * Handles selection-based operations (text replacement or deletion).
 * Works by converting to unformatted values, performing the operation, then reformatting.
 *
 * @param replacement - Text to replace selection with (empty string for deletion)
 */
function handleSelectionOperation(
	selStart: number,
	selEnd: number,
	replacement: string,
	config: EventHandlerConfig,
	inputElement: HTMLInputElement | undefined,
): void {
	// Work in unformatted space to avoid separator complications
	const unformattedValue = toUnformatted(config.store.displayValue, config.locale)
	const unformattedStart = formattedToUnformattedPos(
		config.store.displayValue,
		selStart,
		config.locale,
	)
	const unformattedEnd = formattedToUnformattedPos(config.store.displayValue, selEnd, config.locale)

	// Perform the operation: delete selection and insert replacement
	const newUnformattedValue =
		unformattedValue.slice(0, unformattedStart) +
		replacement +
		unformattedValue.slice(unformattedEnd)
	const newUnformattedCursorPos = unformattedStart + replacement.length

	// Reapply formatting and update everything
	const { formattedValue, newCursorPos } = applyLiveFormatting(
		newUnformattedValue,
		newUnformattedCursorPos,
		config.locale,
		config.formatOptions.maximumFractionDigits,
	)

	updateValues(formattedValue, newCursorPos, inputElement, config)
}

/**
 * Handles backspace/delete when cursor is adjacent to thousand separators.
 * Since separators aren't "real" characters, we need to skip over them and
 * delete the actual numeric character instead.
 *
 * @param direction - 'before' for backspace, 'after' for delete key
 * @returns true if a separator deletion was handled, false otherwise
 */
function handleSeparatorDeletion(
	cursorPos: number,
	direction: 'before' | 'after',
	config: EventHandlerConfig,
	inputElement: HTMLInputElement | undefined,
): boolean {
	const { groupSeparator } = getLocaleSeparators(config.locale)
	const charToCheck =
		direction === 'before'
			? config.store.displayValue[cursorPos - 1] // Character before cursor
			: config.store.displayValue[cursorPos] // Character at cursor

	// Only handle if we're actually at a separator
	if (charToCheck !== groupSeparator) return false

	// Convert to unformatted space where separators don't exist
	const unformattedValue = toUnformatted(config.store.displayValue, config.locale)
	const unformattedCursorPos = formattedToUnformattedPos(
		config.store.displayValue,
		cursorPos,
		config.locale,
	)

	// Delete the actual numeric character in unformatted string
	let newUnformattedValue: string
	let newUnformattedCursorPos: number

	if (direction === 'before' && unformattedCursorPos > 0) {
		// Backspace: delete character before cursor
		newUnformattedValue =
			unformattedValue.slice(0, unformattedCursorPos - 1) +
			unformattedValue.slice(unformattedCursorPos)
		newUnformattedCursorPos = unformattedCursorPos - 1
	} else if (direction === 'after' && unformattedCursorPos < unformattedValue.length) {
		// Delete: remove character at cursor
		newUnformattedValue =
			unformattedValue.slice(0, unformattedCursorPos) +
			unformattedValue.slice(unformattedCursorPos + 1)
		newUnformattedCursorPos = unformattedCursorPos
	} else {
		// Can't delete (at boundary)
		return false
	}

	// Reapply formatting with new value
	const { formattedValue, newCursorPos } = applyLiveFormatting(
		newUnformattedValue,
		newUnformattedCursorPos,
		config.locale,
		config.formatOptions.maximumFractionDigits,
	)

	updateValues(formattedValue, newCursorPos, inputElement, config)
	return true
}

// Simple check for obvious corruption - be very conservative, only reject clear nonsense
function isInputValueReliable(inputValue: string): boolean {
	if (!inputValue) return false

	// Only reject obvious corruption - be very permissive
	// 1. Extremely long values (likely concatenation gone wrong)
	if (inputValue.length > 30) return false

	// 2. Multiple dots (clear corruption for decimal separator)
	const dots = (inputValue.match(/\./g) || []).length
	if (dots > 1) return false

	// 3. Multiple commas AND dots together (mixed corruption)
	const commas = (inputValue.match(/,/g) || []).length
	if (dots > 0 && commas > 2) return false // Allow some commas for thousands, but not excessive

	// Otherwise, trust inputElement.value for proper cursor handling
	return true
}

export function createFocusHandler(
	store: InputStore,
	getInputElement: () => HTMLInputElement | undefined,
) {
	return function handleFocus() {
		store.setFocus(true)

		// If the field contains just "0", select it all for easy replacement
		const inputElement = getInputElement()
		if (store.displayValue === '0' && inputElement) {
			setTimeout(() => {
				if (inputElement) {
					inputElement.select()
				}
			}, 0)
		}
	}
}

/**
 * Creates the keydown event handler for the formatted number input.
 *
 * This handler manages:
 * - Selection-based operations (replace selected text, delete selection)
 * - Thousand separator navigation (skip over separators when deleting)
 * - Input validation (prevent invalid characters)
 * - Keyboard shortcuts (Ctrl+A, Ctrl+V, etc.)
 */
export function createKeyDownHandler(
	config: EventHandlerConfig,
	getInputElement: () => HTMLInputElement | undefined,
) {
	return function handleKeyDown(event: KeyboardEvent) {
		const inputElement = getInputElement()
		if (!inputElement) return

		const selStart = inputElement.selectionStart || 0
		const selEnd = inputElement.selectionEnd || 0
		const hasSelection = selStart !== selEnd
		const cursorPos = selStart

		// Handle backspace key
		if (event.key === 'Backspace') {
			if (hasSelection) {
				// Delete selected text
				event.preventDefault()
				handleSelectionOperation(selStart, selEnd, '', config, inputElement)
				return
			}

			// Handle backspace on thousand separators (skip over separator, delete actual number)
			if (handleSeparatorDeletion(cursorPos, 'before', config, inputElement)) {
				event.preventDefault()
				return
			}
		}

		// Handle delete key
		if (event.key === 'Delete') {
			// Handle delete on thousand separators (skip over separator, delete actual number)
			if (handleSeparatorDeletion(cursorPos, 'after', config, inputElement)) {
				event.preventDefault()
				return
			}
		}

		// Allow standard navigation and editing keys to pass through
		const allowedKeys = [
			'Backspace',
			'Delete',
			'Tab',
			'Escape',
			'Enter',
			'Home',
			'End',
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ArrowDown',
		]
		if (allowedKeys.includes(event.key)) return

		// Allow standard keyboard shortcuts (copy, paste, select all, cut)
		if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase()))
			return

		// Handle typing over selected text
		if (
			hasSelection &&
			(event.key.match(/[0-9.,]/) || isValidChar(event.key, config.locale, config.constraints?.min))
		) {
			event.preventDefault()

			// Try direct replacement first to preserve formatting when possible
			// Example: selecting "23" in "1,234" and typing "9" should give "1,94"
			const newFormattedValue =
				config.store.displayValue.slice(0, selStart) +
				event.key +
				config.store.displayValue.slice(selEnd)
			const unformattedValue = toUnformatted(newFormattedValue, config.locale)
			const numericValue = parseLocalizedNumber(unformattedValue, config.locale)

			// Use direct replacement if result is valid, otherwise use full formatting
			if (!isNaN(numericValue) && numericValue >= 0) {
				updateValues(newFormattedValue, selStart + 1, inputElement, config)
			} else {
				handleSelectionOperation(selStart, selEnd, event.key, config, inputElement)
			}
			return
		}

		// Prevent invalid characters from being typed
		if (
			shouldPreventChar(
				event.key,
				config.store.displayValue,
				config.locale,
				config.constraints?.min,
				cursorPos,
				config.formatOptions.maximumFractionDigits,
			)
		) {
			event.preventDefault()
		}
	}
}

export function createPasteHandler(
	config: EventHandlerConfig,
	state: EventHandlerState,
	getInputElement: () => HTMLInputElement | undefined,
) {
	return function handlePaste(event: ClipboardEvent) {
		state.isPasteInProgress = true
		event.preventDefault()

		const inputElement = getInputElement()
		if (!inputElement) {
			state.isPasteInProgress = false
			return
		}

		const pastedText = event.clipboardData?.getData('text') || ''
		const start = inputElement.selectionStart || 0
		const end = inputElement.selectionEnd || 0

		// Use reliable current value for both filtering and cursor operations
		const currentValue = isInputValueReliable(inputElement.value)
			? inputElement.value
			: config.store.displayValue

		const filteredText = filterPastedText(
			pastedText,
			config.locale,
			config.constraints?.min,
			config.formatOptions.maximumFractionDigits,
			currentValue,
		)

		// Convert to unformatted space for proper concatenation
		const unformattedCurrent = toUnformatted(currentValue, config.locale)
		const unformattedFiltered = toUnformatted(filteredText, config.locale)
		const unformattedStart = formattedToUnformattedPos(currentValue, start, config.locale)
		const unformattedEnd = formattedToUnformattedPos(currentValue, end, config.locale)

		const newUnformattedValue =
			unformattedCurrent.slice(0, unformattedStart) +
			unformattedFiltered +
			unformattedCurrent.slice(unformattedEnd)

		// Skip digit validation when decimal separators were removed from paste
		// (both current value and pasted text had decimals)
		const skipValidation =
			(currentValue.includes('.') || currentValue.includes(',')) &&
			(pastedText.includes('.') || pastedText.includes(','))

		if (
			!skipValidation &&
			!validateDigitLimits(
				newUnformattedValue,
				config.locale,
				config.formatOptions.maximumFractionDigits,
			)
		) {
			state.isPasteInProgress = false
			return
		}

		const newCursorPos = unformattedStart + unformattedFiltered.length

		// Apply formatting and update
		const { formattedValue, newCursorPos: finalCursorPos } = applyLiveFormatting(
			newUnformattedValue,
			newCursorPos,
			config.locale,
			config.formatOptions.maximumFractionDigits,
		)

		updateValues(formattedValue, finalCursorPos, inputElement, config)

		setTimeout(() => {
			state.isPasteInProgress = false
		}, 0)
	}
}

export function createInputHandler(
	config: EventHandlerConfig,
	state: EventHandlerState,
	getInputElement: () => HTMLInputElement | undefined,
) {
	return function handleInput(event: Event) {
		// If paste is in progress, ignore this input event as it's being handled by paste handler
		if (state.isPasteInProgress) {
			return
		}

		const target = event.target as HTMLInputElement
		const rawInput = target.value
		const cursorPos = target.selectionStart || 0

		// Apply live formatting
		const { formattedValue, newCursorPos } = applyLiveFormatting(
			rawInput,
			cursorPos,
			config.locale,
			config.formatOptions.maximumFractionDigits,
		)

		updateValues(formattedValue, newCursorPos, getInputElement(), config)
	}
}

export function createBlurHandler(config: EventHandlerConfig) {
	return function handleBlur() {
		config.store.setFocus(false)

		// Only apply min/max constraints if value is defined and not empty/incomplete
		if (
			config.store.value !== undefined &&
			config.store.displayValue !== '' &&
			config.store.displayValue !== '-'
		) {
			const constrainedValue = applyConstraints(
				config.store.value,
				config.constraints?.min,
				config.constraints?.max,
			)

			// Apply constraint validation - set bound value to undefined for violations
			if (constrainedValue !== config.store.value) {
				config.store.setValue(constrainedValue)
			}
		}
	}
}
