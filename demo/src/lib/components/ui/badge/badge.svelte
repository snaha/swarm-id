<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  type Variant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success'

  interface Props extends HTMLAttributes<HTMLDivElement> {
    variant?: Variant
    class?: string
    children?: Snippet
  }

  const VARIANT_CLASSES: Record<Variant, string> = {
    default: 'border-transparent bg-primary text-primary-foreground shadow',
    secondary: 'border-transparent bg-secondary text-secondary-foreground',
    destructive: 'border-transparent bg-destructive text-destructive-foreground shadow',
    outline: 'text-foreground',
    success: 'border-transparent bg-success text-success-foreground shadow',
  }

  let { variant = 'default', class: className, children, ...restProps }: Props = $props()
</script>

<div
  class={cn(
    'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
    VARIANT_CLASSES[variant],
    className,
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</div>
