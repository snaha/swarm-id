import {
  getLocaleSeparators,
  toUnformatted,
  formattedToUnformattedPos,
  applyLiveFormatting,
  filterPastedText,
  shouldPreventChar,
  applyConstraints,
  validateDigitLimits,
  MAX_INTEGER_DIGITS,
} from './logic'
import type { BigintInputStore } from './store.svelte'

export interface EventHandlerConfig {
  store: BigintInputStore
  locale: string | undefined
  constraints?: {
    min?: bigint
    max?: bigint
  }
}

export interface EventHandlerState {
  isPasteInProgress: boolean
}

/**
 * Sets cursor position with cross-browser compatibility.
 */
function setCursorPosition(inputElement: HTMLInputElement | undefined, position: number): void {
  if (!inputElement) return

  try {
    inputElement.setSelectionRange(position, position)
    setTimeout(() => {
      try {
        inputElement.setSelectionRange(position, position)
      } catch {
        // Silently ignore errors
      }
    }, 0)
  } catch {
    // Silently ignore errors
  }
}

/**
 * Common helper to update display value, store value, and cursor position.
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
 */
function handleSelectionOperation(
  selStart: number,
  selEnd: number,
  replacement: string,
  config: EventHandlerConfig,
  inputElement: HTMLInputElement | undefined,
): void {
  const unformattedValue = toUnformatted(config.store.displayValue, config.locale)
  const unformattedStart = formattedToUnformattedPos(
    config.store.displayValue,
    selStart,
    config.locale,
  )
  const unformattedEnd = formattedToUnformattedPos(config.store.displayValue, selEnd, config.locale)

  const newUnformattedValue =
    unformattedValue.slice(0, unformattedStart) +
    replacement +
    unformattedValue.slice(unformattedEnd)
  const newUnformattedCursorPos = unformattedStart + replacement.length

  const { formattedValue, newCursorPos } = applyLiveFormatting(
    newUnformattedValue,
    newUnformattedCursorPos,
    config.locale,
  )

  updateValues(formattedValue, newCursorPos, inputElement, config)
}

/**
 * Handles backspace/delete when cursor is adjacent to thousand separators.
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
      ? config.store.displayValue[cursorPos - 1]
      : config.store.displayValue[cursorPos]

  if (charToCheck !== groupSeparator) return false

  const unformattedValue = toUnformatted(config.store.displayValue, config.locale)
  const unformattedCursorPos = formattedToUnformattedPos(
    config.store.displayValue,
    cursorPos,
    config.locale,
  )

  let newUnformattedValue: string
  let newUnformattedCursorPos: number

  if (direction === 'before' && unformattedCursorPos > 0) {
    newUnformattedValue =
      unformattedValue.slice(0, unformattedCursorPos - 1) +
      unformattedValue.slice(unformattedCursorPos)
    newUnformattedCursorPos = unformattedCursorPos - 1
  } else if (direction === 'after' && unformattedCursorPos < unformattedValue.length) {
    newUnformattedValue =
      unformattedValue.slice(0, unformattedCursorPos) +
      unformattedValue.slice(unformattedCursorPos + 1)
    newUnformattedCursorPos = unformattedCursorPos
  } else {
    return false
  }

  const { formattedValue, newCursorPos } = applyLiveFormatting(
    newUnformattedValue,
    newUnformattedCursorPos,
    config.locale,
  )

  updateValues(formattedValue, newCursorPos, inputElement, config)
  return true
}

function isInputValueReliable(inputValue: string): boolean {
  if (!inputValue) return false
  if (inputValue.length > MAX_INTEGER_DIGITS + 1) return false
  return true
}

export function createFocusHandler(
  store: BigintInputStore,
  getInputElement: () => HTMLInputElement | undefined,
) {
  return function handleFocus() {
    store.setFocus(true)

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
 * Creates the keydown event handler for the formatted bigint input.
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
        event.preventDefault()
        handleSelectionOperation(selStart, selEnd, '', config, inputElement)
        return
      }

      if (handleSeparatorDeletion(cursorPos, 'before', config, inputElement)) {
        event.preventDefault()
        return
      }
    }

    // Handle delete key
    if (event.key === 'Delete') {
      if (handleSeparatorDeletion(cursorPos, 'after', config, inputElement)) {
        event.preventDefault()
        return
      }
    }

    // Allow standard navigation and editing keys
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

    // Allow standard keyboard shortcuts
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase()))
      return

    // Handle typing over selected text
    if (hasSelection && /[0-9-]/.test(event.key)) {
      event.preventDefault()

      const newFormattedValue =
        config.store.displayValue.slice(0, selStart) +
        event.key +
        config.store.displayValue.slice(selEnd)
      const unformattedValue = toUnformatted(newFormattedValue, config.locale)

      try {
        const bigintValue = BigInt(unformattedValue)
        if (
          bigintValue >= 0n ||
          config.constraints?.min === undefined ||
          config.constraints.min < 0n
        ) {
          updateValues(newFormattedValue, selStart + 1, inputElement, config)
        } else {
          handleSelectionOperation(selStart, selEnd, event.key, config, inputElement)
        }
      } catch {
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

    const currentValue = isInputValueReliable(inputElement.value)
      ? inputElement.value
      : config.store.displayValue

    const filteredText = filterPastedText(pastedText, config.locale, config.constraints?.min)

    const unformattedCurrent = toUnformatted(currentValue, config.locale)
    const unformattedFiltered = toUnformatted(filteredText, config.locale)
    const unformattedStart = formattedToUnformattedPos(currentValue, start, config.locale)
    const unformattedEnd = formattedToUnformattedPos(currentValue, end, config.locale)

    const newUnformattedValue =
      unformattedCurrent.slice(0, unformattedStart) +
      unformattedFiltered +
      unformattedCurrent.slice(unformattedEnd)

    if (!validateDigitLimits(newUnformattedValue)) {
      state.isPasteInProgress = false
      return
    }

    const newCursorPos = unformattedStart + unformattedFiltered.length

    const { formattedValue, newCursorPos: finalCursorPos } = applyLiveFormatting(
      newUnformattedValue,
      newCursorPos,
      config.locale,
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
    if (state.isPasteInProgress) {
      return
    }

    const target = event.target as HTMLInputElement
    const rawInput = target.value
    const cursorPos = target.selectionStart || 0

    const { formattedValue, newCursorPos } = applyLiveFormatting(rawInput, cursorPos, config.locale)

    updateValues(formattedValue, newCursorPos, getInputElement(), config)
  }
}

export function createBlurHandler(config: EventHandlerConfig) {
  return function handleBlur() {
    config.store.setFocus(false)

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

      if (constrainedValue !== config.store.value) {
        config.store.setValue(constrainedValue)
      }
    }
  }
}
