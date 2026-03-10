<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  interface Props extends HTMLAttributes<HTMLHeadingElement> {
    class?: string
    children?: Snippet
  }

  let { class: className, children, ...restProps }: Props = $props()
</script>

<h5 class={cn('mb-1 font-medium leading-none tracking-tight', className)} {...restProps}>
  {#if children}
    {@render children()}
  {/if}
</h5>
