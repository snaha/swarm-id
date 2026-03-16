<script lang="ts">
  import Input from '../input.svelte'
  import type { Props as InputProps } from '../input.svelte'
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { withBigintInputStore } from './store.svelte'
  import {
    createKeyDownHandler,
    createPasteHandler,
    createInputHandler,
    createBlurHandler,
    createFocusHandler,
  } from './events'

  type Props = Omit<InputProps & HTMLInputAttributes, 'type' | 'value' | 'min' | 'max'> & {
    value?: bigint
    min?: bigint
    max?: bigint
    locale: string | undefined
  }

  let { value = $bindable(), min, max, locale, placeholder = '0', ...restProps }: Props = $props()

  let inputElement = $state<HTMLInputElement>()

  // Create store instance for this input
  const store = withBigintInputStore(value)

  // Simple state for event coordination
  let eventState = $state({ isPasteInProgress: false })

  // Update display value when value prop changes from outside
  $effect(() => {
    store.updateDisplayValue(value, locale)
  })

  // Sync store value with bound prop (for user input changes)
  $effect(() => {
    if (store.value !== value) {
      value = store.value
    }
  })

  // Shared config object for all event handlers
  const config = $derived({
    store,
    locale: locale,
    constraints: { min, max },
  })

  // Create event handlers
  const handleFocus = $derived(createFocusHandler(store, () => inputElement))
  const handleBlur = $derived(createBlurHandler(config))
  const handleKeyDown = $derived(createKeyDownHandler(config, () => inputElement))
  const handlePaste = $derived(createPasteHandler(config, eventState, () => inputElement))
  const handleInput = $derived(createInputHandler(config, eventState, () => inputElement))

  // Reactive display value from store
  // eslint-disable-next-line svelte/prefer-writable-derived -- displayValue is bound bidirectionally, must be writable
  let displayValue = $state(store.displayValue)
  $effect(() => {
    displayValue = store.displayValue
  })
</script>

<Input
  type="text"
  inputmode="numeric"
  bind:value={displayValue}
  bind:input={inputElement}
  onfocus={handleFocus}
  onblur={handleBlur}
  oninput={handleInput}
  onkeydown={handleKeyDown}
  onpaste={handlePaste}
  {placeholder}
  {...restProps}
/>
