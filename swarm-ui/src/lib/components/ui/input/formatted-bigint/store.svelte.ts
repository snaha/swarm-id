import { formatBigint, parseBigint } from './logic'

export interface BigintInputStore {
  readonly value: bigint | undefined
  readonly displayValue: string
  readonly isFocused: boolean
  updateValue: (formattedValue: string, locale: string | undefined) => void
  setValue: (newValue: bigint | undefined) => void
  setDisplayValue: (newDisplayValue: string) => void
  updateDisplayValue: (value: bigint | undefined, locale: string | undefined) => void
  setFocus: (focused: boolean) => void
}

export function withBigintInputStore(initialValue?: bigint): BigintInputStore {
  let value = $state<bigint | undefined>(initialValue)
  let displayValue = $state(initialValue !== undefined ? String(initialValue) : '')
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

    updateValue(formattedValue: string, locale: string | undefined) {
      const parsedValue = parseBigint(formattedValue, locale)
      if (parsedValue !== undefined) {
        value = parsedValue
      } else if (formattedValue === '') {
        value = undefined
      } else if (formattedValue === '-') {
        // Just minus sign - keep display but don't change value yet
      }
    },

    setValue(newValue: bigint | undefined) {
      value = newValue
    },

    setDisplayValue(newDisplayValue: string) {
      displayValue = newDisplayValue
    },

    // Update display value from a bigint value
    updateDisplayValue(newValue: bigint | undefined, locale: string | undefined) {
      value = newValue

      if (!isFocused) {
        if (newValue !== undefined) {
          displayValue = formatBigint(newValue, locale)
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
