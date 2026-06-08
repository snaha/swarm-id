<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'

  import { type WithElementRef, cn } from '$lib/utils'

  let {
    ref = $bindable(undefined),
    value = $bindable(),
    class: className,
    ...restProps
  }: WithElementRef<HTMLInputAttributes, HTMLInputElement> = $props()
</script>

<input
  bind:this={ref}
  bind:value
  data-slot="input"
  class={cn(
    'border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive flex h-8 w-full min-w-0 rounded-lg border px-2.5 py-1 text-sm transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  {...restProps}
/>
