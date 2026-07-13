<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Menu with the shared dismissal contract: the trigger toggles, a pointerdown
  outside closes, Escape closes (returning focus to the trigger), and
  ArrowUp/ArrowDown/Home/End move focus across the menu items. Items rendered
  through `DropdownMenuItem` close the menu when activated; other panel content
  closes it by flipping the bindable `open`.
-->

<script lang="ts" module>
  export interface DropdownMenuContext {
    close: () => void
  }

  export const DROPDOWN_MENU_CONTEXT = Symbol('dropdown-menu')

  interface TriggerProps {
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    onclick: () => void
  }
</script>

<script lang="ts">
  import { type Snippet, setContext } from 'svelte'

  import { cn } from '$lib/utils'

  interface Props {
    open?: boolean
    /** Panel placement and sizing classes, e.g. `top-full right-0 mt-1 min-w-36 p-1`. */
    class?: string
    /** The toggle button; spread the given props onto it. */
    trigger: Snippet<[TriggerProps]>
    children: Snippet
  }

  let { open = $bindable(false), class: className, trigger, children }: Props = $props()

  let container = $state<HTMLDivElement>()
  let panel = $state<HTMLDivElement>()

  setContext<DropdownMenuContext>(DROPDOWN_MENU_CONTEXT, { close })

  function close() {
    open = false
  }

  function onWindowPointerDown(event: PointerEvent) {
    // `target` can be a Text node (Firefox), so guard to Node — `contains`
    // accepts any Node, no Element cast needed.
    if (open && container && !(event.target instanceof Node && container.contains(event.target))) {
      close()
    }
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (!open) {
      return
    }
    if (event.key === 'Escape') {
      // Restore focus only when it was inside the menu (it would drop to
      // <body> with the panel unmounted) — never steal it from elsewhere.
      if (focusWithin()) {
        container?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus()
      }
      close()
      return
    }
    moveFocus(event)
  }

  function focusWithin(): boolean {
    return (
      container !== undefined &&
      document.activeElement instanceof Node &&
      container.contains(document.activeElement)
    )
  }

  /** Roving focus across the panel's menu items, wrapping at the ends. */
  function moveFocus(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !focusWithin()) {
      return
    }
    const items = panel ? [...panel.querySelectorAll<HTMLElement>('[role^="menuitem"]')] : []
    if (items.length === 0) {
      return
    }
    event.preventDefault()
    const active = document.activeElement
    const current = active instanceof HTMLElement ? items.indexOf(active) : -1
    const last = items.length - 1
    if (event.key === 'Home') {
      items[0].focus()
    } else if (event.key === 'End') {
      items[last].focus()
    } else if (event.key === 'ArrowDown') {
      items[current < 0 || current === last ? 0 : current + 1].focus()
    } else {
      items[current <= 0 ? last : current - 1].focus()
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div bind:this={container} class="relative">
  {@render trigger({
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onclick: () => (open = !open),
  })}

  {#if open}
    <div
      bind:this={panel}
      role="menu"
      tabindex="-1"
      class={cn(
        'bg-popover text-popover-foreground absolute z-50 rounded-lg border shadow-md',
        className,
      )}
    >
      {@render children()}
    </div>
  {/if}
</div>
