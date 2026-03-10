<script lang="ts">
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'

  interface Props {
    open?: boolean
    class?: string
    trigger: Snippet
    children: Snippet
  }

  let { open = $bindable(false), class: className, trigger, children }: Props = $props()

  function onClickOutside(event: MouseEvent) {
    if (!open) return
    const target = event.target as Node
    if (wrapper && !wrapper.contains(target)) {
      open = false
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      open = false
    }
  }

  let wrapper: HTMLDivElement | undefined = $state(undefined)
</script>

<svelte:document onclick={onClickOutside} onkeydown={onKeydown} />

<div class={cn('relative', className)} bind:this={wrapper}>
  {@render trigger()}
  <div
    class={cn(
      'absolute bottom-full left-0 right-0 mb-2 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg transition-all duration-150',
      open ? 'visible opacity-100' : 'invisible opacity-0',
    )}
  >
    {@render children()}
  </div>
</div>
