<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    open?: boolean
    class?: string
    children?: Snippet
  }

  let { open = $bindable(false), class: className, children }: Props = $props()
</script>

<div class={className} data-state={open ? 'open' : 'closed'}>
  {#if children}
    {@render children()}
  {/if}
</div>
