<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { type Snippet, getContext } from 'svelte'

  import { cn } from '$lib/utils'

  import { DROPDOWN_MENU_CONTEXT, type DropdownMenuContext } from './dropdown-menu.svelte'

  interface Props {
    /** Renders an anchor instead of a button (e.g. external links). */
    href?: string
    target?: string
    rel?: string
    /** Set for a radio item — `role="menuitemradio"` with this checked state. */
    checked?: boolean
    class?: string
    onclick?: () => void
    children: Snippet
  }

  let { href, target, rel, checked, class: className, onclick, children }: Props = $props()

  const { close } = getContext<DropdownMenuContext>(DROPDOWN_MENU_CONTEXT)

  const itemClass = $derived(
    cn(
      'hover:bg-muted focus-visible:bg-muted flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none',
      className,
    ),
  )

  function activate() {
    onclick?.()
    close()
  }
</script>

{#if href}
  <a {href} {target} {rel} role="menuitem" class={itemClass} onclick={activate}>
    {@render children()}
  </a>
{:else if checked === undefined}
  <button type="button" role="menuitem" class={itemClass} onclick={activate}>
    {@render children()}
  </button>
{:else}
  <button
    type="button"
    role="menuitemradio"
    aria-checked={checked}
    class={itemClass}
    onclick={activate}
  >
    {@render children()}
  </button>
{/if}
