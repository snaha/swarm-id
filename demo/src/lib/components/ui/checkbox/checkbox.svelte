<script lang="ts">
  import { cn } from '$lib/utils'

  interface Props {
    checked?: boolean
    disabled?: boolean
    class?: string
    id?: string
    onchange?: (checked: boolean) => void
  }

  let {
    checked = $bindable(false),
    disabled = false,
    class: className,
    id,
    onchange,
  }: Props = $props()

  function toggle() {
    if (disabled) return
    checked = !checked
    onchange?.(checked)
  }
</script>

<button
  type="button"
  role="checkbox"
  aria-checked={checked}
  {disabled}
  {id}
  class={cn(
    'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
    checked ? 'bg-primary text-primary-foreground' : 'bg-background',
    className,
  )}
  onclick={toggle}
>
  {#if checked}
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5"
    >
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  {/if}
</button>
