<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements'

  import { type WithElementRef, cn } from '$lib/utils'

  let {
    ref = $bindable(undefined),
    value = $bindable(),
    class: className,
    ...restProps
  }: WithElementRef<HTMLTextareaAttributes, HTMLTextAreaElement> = $props()
</script>

<textarea
  bind:this={ref}
  bind:value
  data-slot="textarea"
  class={cn(
    'border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full resize-none rounded-lg border px-2.5 py-2 text-sm transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )}
  {...restProps}
></textarea>
