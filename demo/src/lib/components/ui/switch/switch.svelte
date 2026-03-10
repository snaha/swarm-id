<script lang="ts">
  import { cn } from '$lib/utils'

  interface Props {
    checked?: boolean
    disabled?: boolean
    class?: string
    onchange?: (checked: boolean) => void
  }

  let { checked = $bindable(false), disabled = false, class: className, onchange }: Props = $props()

  function toggle() {
    if (disabled) return
    checked = !checked
    onchange?.(checked)
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  {disabled}
  class={cn(
    'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
    checked ? 'bg-primary' : 'bg-input',
    className,
  )}
  onclick={toggle}
>
  <span
    class={cn(
      'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
      checked ? 'translate-x-4' : 'translate-x-0',
    )}
  ></span>
</button>
