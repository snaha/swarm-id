<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import Copy from '@lucide/svelte/icons/copy'
  import Eye from '@lucide/svelte/icons/eye'

  import { Button } from '$lib/components/ui/button'
  import { toastStore } from '$lib/stores/toast.svelte'
  import { copyToClipboard, truncateAddress } from '$lib/utils'

  const MASKED_KEY = '•'.repeat(66)

  interface KeyRow {
    label: string
    description: string
    value: string
  }

  interface Props {
    id: string
    title: string
    address: KeyRow
    /** Omit it and the card shows no public key row (drive management has none). */
    publicKey?: KeyRow
    privateKey: Omit<KeyRow, 'value'>
    /**
     * The private key once revealed, for a reveal that completes elsewhere (an
     * unlock dialog). A reveal that needs no ceremony returns the key from
     * `onreveal` instead and the card keeps it itself. Collapsing clears both.
     */
    revealed?: string | undefined
    onreveal: () => string | undefined
    open?: boolean
  }

  let {
    id,
    title,
    address,
    publicKey,
    privateKey,
    revealed = $bindable(),
    onreveal,
    open = $bindable(false),
  }: Props = $props()

  let shown = $state<string | undefined>(undefined)
  const displayed = $derived(revealed ?? shown)

  function reveal() {
    shown = onreveal()
  }

  function toggle() {
    open = !open
    // Reopening asks for the private key again rather than showing it still.
    if (!open) {
      revealed = undefined
      shown = undefined
    }
  }

  async function copyText(text: string, what: string) {
    if (await copyToClipboard(text)) {
      toastStore.show(`${what} copied to clipboard`)
    } else {
      toastStore.show('Could not copy to clipboard')
    }
  }
</script>

{#snippet keyBlock(label: string, description: string)}
  <div class="flex flex-col">
    <p class="text-sm font-medium">{label}</p>
    <p class="text-muted-foreground text-xs">{description}</p>
  </div>
{/snippet}

{#snippet keyRow(row: KeyRow)}
  <div class="bg-muted flex flex-col gap-1 rounded-md p-4">
    {@render keyBlock(row.label, row.description)}
    <div class="flex items-center gap-2">
      <p class="min-w-0 flex-1 text-sm break-all">{row.value}</p>
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        aria-label="Copy {row.label.toLowerCase()}"
        onclick={() => copyText(row.value, row.label)}
      >
        <Copy />
      </Button>
    </div>
  </div>
{/snippet}

<div {id} class="border-border flex w-full flex-col rounded-lg border">
  <p class="px-4 pt-4 text-sm font-bold">{title}</p>
  <div class="flex h-12 w-full items-center gap-2 px-4">
    <p class="flex-1 truncate text-sm">{truncateAddress(address.value)}</p>
    <Button variant="ghost" size="sm" onclick={() => copyText(address.value, address.label)}>
      <Copy />
      Copy
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="-mr-2 size-7"
      aria-label={open ? `Hide ${title.toLowerCase()} keys` : `Show ${title.toLowerCase()} keys`}
      onclick={toggle}
    >
      <ChevronsUpDown />
    </Button>
  </div>
  {#if open}
    <div class="mx-1 mb-1 flex flex-col gap-1">
      {@render keyRow(address)}
      {#if publicKey}
        {@render keyRow(publicKey)}
      {/if}
      <div class="bg-muted flex flex-col gap-1 rounded-md p-4">
        {@render keyBlock(privateKey.label, privateKey.description)}
        <div class="flex items-center gap-2">
          {#if displayed}
            <p class="min-w-0 flex-1 text-sm break-all">{displayed}</p>
            <Button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="Copy {privateKey.label.toLowerCase()}"
              onclick={() => displayed && copyText(displayed, privateKey.label)}
            >
              <Copy />
            </Button>
          {:else}
            <p class="min-w-0 flex-1 text-sm break-all select-none">{MASKED_KEY}</p>
            <Button
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label="Reveal {privateKey.label.toLowerCase()}"
              onclick={reveal}
            >
              <Eye />
            </Button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
