export const MAX_INTEGER_DIGITS = 30 // Support up to 10^30 (enough for any PLUR amount)

export interface LocaleSeparators {
  groupSeparator: string
}

export interface FormatResult {
  formattedValue: string
  newCursorPos: number
}

// Get locale-specific group separator
export function getLocaleSeparators(locale: string | undefined): LocaleSeparators {
  const formatter = new Intl.NumberFormat(locale || undefined)
  const parts = formatter.formatToParts(1234n)

  const groupSeparator = parts.find((part) => part.type === 'group')?.value || ','

  return { groupSeparator }
}

// Format bigint with thousand separators
export function formatBigint(value: bigint, locale: string | undefined): string {
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
  }).format(value)
}

// Parse formatted string to bigint
export function parseBigint(
  formattedValue: string,
  locale: string | undefined,
): bigint | undefined {
  if (!formattedValue || formattedValue === '-') return undefined

  // Remove thousand separators
  const { groupSeparator } = getLocaleSeparators(locale)
  const cleaned = formattedValue.replace(new RegExp(`\\${groupSeparator}`, 'g'), '')

  // Remove any decimal part (shouldn't exist but just in case)
  const integerPart = cleaned.split(/[.,]/)[0]

  if (!integerPart || integerPart === '-') return undefined

  try {
    return BigInt(integerPart)
  } catch {
    return undefined
  }
}

// Check if character is valid for bigint input
export function isValidBigintChar(char: string, min?: bigint): boolean {
  if (/[0-9]/.test(char)) return true

  // Only allow minus sign if min is not set or allows negative numbers
  if (char === '-' && (min === undefined || min < 0n)) return true

  return false
}

// Convert formatted string to unformatted (remove thousand separators)
export function toUnformatted(formattedValue: string, locale: string | undefined): string {
  const { groupSeparator } = getLocaleSeparators(locale)
  return formattedValue.replace(new RegExp(`\\${groupSeparator}`, 'g'), '')
}

// Convert cursor position from formatted string to unformatted position
export function formattedToUnformattedPos(
  formattedValue: string,
  formattedPos: number,
  locale: string | undefined,
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
  locale: string | undefined,
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
  locale: string | undefined,
): FormatResult {
  const { groupSeparator } = getLocaleSeparators(locale)

  // Remove all group separators to get the raw numeric value
  const unformattedValue = toUnformatted(rawValue, locale)

  // Calculate cursor position in the unformatted string
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

  // Handle just minus sign
  if (unformattedValue === '-') {
    return { formattedValue: unformattedValue, newCursorPos: unformattedCursorPos }
  }

  // Normalize multiple consecutive zeros to a single zero
  if (/^0+$/.test(unformattedValue)) {
    return { formattedValue: '0', newCursorPos: 1 }
  }

  // Try to parse as bigint
  try {
    const bigintValue = BigInt(unformattedValue)
    const formatted = formatBigint(bigintValue, locale)

    // Convert unformatted cursor position back to formatted position
    const newCursorPos = unformattedToFormattedPos(formatted, unformattedCursorPos, locale)

    return { formattedValue: formatted, newCursorPos }
  } catch {
    // If invalid bigint, keep original input
    return { formattedValue: rawValue, newCursorPos: cursorPos }
  }
}

// Filter pasted text to remove invalid characters
export function filterPastedText(
  pastedText: string,
  locale: string | undefined,
  min?: bigint,
): string {
  const { groupSeparator } = getLocaleSeparators(locale)

  // Filter to only valid bigint characters
  let filteredText = pastedText
    .split('')
    .filter((char) => isValidBigintChar(char, min) || char === groupSeparator)
    .join('')

  // Remove group separators - they'll be added back during formatting
  filteredText = filteredText.replace(new RegExp(`\\${groupSeparator}`, 'g'), '')

  // Remove any decimal separators and everything after
  const decimalIndex = Math.max(filteredText.indexOf('.'), filteredText.indexOf(','))
  if (decimalIndex !== -1) {
    filteredText = filteredText.slice(0, decimalIndex)
  }

  // Normalize leading zeros: if we're pasting only zeros, keep only one
  if (filteredText && /^0+$/.test(filteredText)) {
    filteredText = '0'
  }

  return filteredText
}

// Check if we should prevent typing a character
export function shouldPreventChar(
  key: string,
  displayValue: string,
  locale: string | undefined,
  min?: bigint,
  cursorPos?: number,
): boolean {
  // Check if the typed character is valid
  if (!isValidBigintChar(key, min)) {
    return true
  }

  // Prevent typing additional zeros if the field only contains zeros
  if (key === '0') {
    const unformattedValue = toUnformatted(displayValue, locale)
    if (/^0+$/.test(unformattedValue)) {
      return true
    }
  }

  // Prevent typing more digits if we're at the limit
  if (/[0-9]/.test(key)) {
    const unformattedValue = toUnformatted(displayValue, locale)
    if (unformattedValue.replace(/^-/, '').length >= MAX_INTEGER_DIGITS) {
      return true
    }
  }

  // Prevent typing minus if not at start or already has minus
  if (key === '-') {
    if ((cursorPos !== undefined && cursorPos !== 0) || displayValue.includes('-')) {
      return true
    }
  }

  return false
}

// Validate if a value respects digit limits
export function validateDigitLimits(unformattedValue: string): boolean {
  // Check integer digit limit (remove minus sign if present)
  if (unformattedValue.replace(/^-/, '').length > MAX_INTEGER_DIGITS) {
    return false
  }

  return true
}

// Apply min/max constraints, returning undefined for violations
export function applyConstraints(value: bigint, min?: bigint, max?: bigint): bigint | undefined {
  if (value === 0n && min !== undefined && min > 0n) {
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
