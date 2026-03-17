<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    children: Snippet
    class?: string
    cssGridTemplateColumns?: string
    cssGap?: string
    cssAlignItems?: string
    [key: string]: unknown
  }

  let {
    children,
    class: className,
    cssGridTemplateColumns = '1fr 1fr',
    cssGap = 'var(--padding)',
    cssAlignItems = 'center',
    ...restProps
  }: Props = $props()
</script>

<div
  class="grid {className ?? ''}"
  style:--grid-template-columns={cssGridTemplateColumns}
  style:--grid-gap={cssGap}
  style:--grid-align-items={cssAlignItems}
  {...restProps}
>
  {@render children()}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: var(--grid-template-columns);
    gap: var(--grid-gap);
    align-items: var(--grid-align-items);
  }
</style>
