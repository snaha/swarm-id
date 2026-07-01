<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements'

  import { type VariantProps, tv } from 'tailwind-variants'

  import { cn } from '$lib/utils'

  export const badgeVariants = tv({
    base: 'inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground',
        destructive: 'bg-destructive/10 text-destructive',
        outline: 'border-border text-foreground border',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  })

  export type BadgeVariant = VariantProps<typeof badgeVariants>['variant']
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    variant?: BadgeVariant
    class?: string
    children: Snippet
  }

  let { variant = 'default', class: className, children, ...restProps }: Props = $props()
</script>

<span data-slot="badge" class={cn(badgeVariants({ variant }), className)} {...restProps}>
  {@render children()}
</span>
