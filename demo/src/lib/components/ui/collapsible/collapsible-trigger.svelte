<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    onclick?: () => void
    class?: string
    children?: Snippet
  }

  let { onclick, class: className, children }: Props = $props()
</script>

<button type="button" class={className} {onclick}>
  {#if children}
    {@render children()}
  {/if}
</button>
