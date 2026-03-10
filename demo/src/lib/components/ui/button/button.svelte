<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  type Variant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  type Size = 'default' | 'sm' | 'lg' | 'icon'

  interface Props extends HTMLButtonAttributes {
    variant?: Variant
    size?: Size
    class?: string
    children?: Snippet
  }

  const VARIANT_CLASSES: Record<Variant, string> = {
    default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
    destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
    outline:
      'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
    secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    link: 'text-primary underline-offset-4 hover:underline',
  }

  const SIZE_CLASSES: Record<Size, string> = {
    default: 'h-9 px-4 py-2',
    sm: 'h-8 rounded-md px-3 text-xs',
    lg: 'h-10 rounded-md px-8',
    icon: 'h-9 w-9',
  }

  let {
    variant = 'default',
    size = 'default',
    class: className,
    children,
    ...restProps
  }: Props = $props()
</script>

<button
  class={cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  )}
  {...restProps}
>
  {#if children}
    {@render children()}
  {/if}
</button>
