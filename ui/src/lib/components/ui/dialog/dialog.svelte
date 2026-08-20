<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Modal dialog implementing the WAI-ARIA dialog focus contract: on open, focus
  moves into the dialog — to a visible `[data-autofocus]` element if the
  consumer marked one, else the first visible focusable control, else the panel
  itself (also on touch-primary devices when the target is a text field, so the
  software keyboard stays down); Tab and Shift+Tab wrap within the dialog; on
  close, focus returns to the opener.
-->
<script lang="ts">
  import { type Snippet, onMount } from 'svelte'

  import X from '@lucide/svelte/icons/x'

  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'

  interface Props {
    /** Omitted for pending states which render their own centered content. */
    title?: string
    /**
     * The accessible name when there is no visible `title` to take it from.
     * Without one a pending dialog is announced as an unnamed dialog — which is
     * precisely what those screens cover: a wallet approval, a spend in flight.
     */
    ariaLabel?: string
    /** Rendered left of the title — e.g. a back arrow in a multi-step flow. */
    leading?: Snippet
    /** Hide the X button while an operation is pending. */
    dismissable?: boolean
    onclose: () => void
    class?: string
    children: Snippet
  }

  let {
    title,
    ariaLabel,
    leading,
    dismissable = true,
    onclose,
    class: className,
    children,
  }: Props = $props()

  let panel = $state<HTMLDivElement>()

  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ')

  // Text-entry controls summon the software keyboard when focused on touch devices.
  const TEXT_ENTRY_SELECTOR = 'input, textarea, [contenteditable]'

  // The selector alone also matches controls that are currently invisible
  // (`display: none` or `visibility: hidden`, own or inherited); those are not
  // focusable, so counting them would make focus() calls silently fail.
  function isVisible(element: HTMLElement): boolean {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'
  }

  function focusables(): HTMLElement[] {
    return panel
      ? [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isVisible)
      : []
  }

  onMount(() => {
    const opener = document.activeElement
    const autofocus = panel
      ? [...panel.querySelectorAll<HTMLElement>('[data-autofocus]')].find(isVisible)
      : undefined
    let target: HTMLElement | undefined = autofocus ?? focusables()[0] ?? panel
    // On touch-primary devices, focusing a text field on open would also pop
    // the software keyboard over the opening dialog — too much movement at
    // once — so land on the panel instead; the field is one tap away.
    if (
      target?.matches(TEXT_ENTRY_SELECTOR) === true &&
      window.matchMedia('(pointer: coarse)').matches
    ) {
      target = panel
    }
    target?.focus()
    return () => {
      // The opener may be gone by now (e.g. swapping to a pending-state
      // dialog unmounts the previous one while its trigger persists).
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus()
      }
    }
  })

  // Keep Tab cycling inside the dialog; also pulls focus back in if it ever
  // lands outside (e.g. after a click on the overlay).
  function trapTab(event: KeyboardEvent) {
    const items = focusables()
    if (items.length === 0) {
      event.preventDefault()
      panel?.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    const inside = active instanceof HTMLElement && panel?.contains(active) === true
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && dismissable) {
      onclose()
    } else if (event.key === 'Tab') {
      trapTab(event)
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="bg-background/60 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
  <div
    bind:this={panel}
    role="dialog"
    aria-modal="true"
    aria-label={title ?? ariaLabel}
    tabindex="-1"
    class={cn(
      'bg-popover flex w-96 max-w-[calc(100vw-4rem)] flex-col gap-4 rounded-lg border p-4 shadow-lg outline-none',
      className,
    )}
  >
    {#if title !== undefined}
      <div class="flex items-start justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5">
          {#if leading}{@render leading()}{/if}
          <p class="truncate text-sm font-bold">{title}</p>
        </div>
        {#if dismissable}
          <Button
            variant="ghost"
            size="icon"
            class="-mt-1.5 -mr-1.5 size-6 rounded-md [&_svg]:size-3.5"
            aria-label="Close"
            onclick={onclose}
          >
            <X />
          </Button>
        {/if}
      </div>
    {/if}

    {@render children()}
  </div>
</div>
