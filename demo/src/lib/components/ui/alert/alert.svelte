<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  type Variant = 'default' | 'destructive' | 'success' | 'warning'

  interface Props extends HTMLAttributes<HTMLDivElement> {
    variant?: Variant
    class?: string
    children?: Snippet
  }

  const VARIANT_CLASSES: Record<Variant, string> = {
    default: 'bg-background text-foreground',
    destructive: 'border-destructive/50 text-destructive [&>svg]:text-destructive',
    success: 'border-success/50 bg-success/10 text-success-foreground [&>svg]:text-success',
    warning: 'border-warning/50 bg-warning/10 text-warning-foreground [&>svg]:text-warning',
  }

  let { variant = 'default', class: className, children, ...restProps }: Props = $props()
</script>

<div
  role="alert"
  class={cn(
    'relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7',
    VARIANT_CLASSES[variant],
    className,
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</div>
