<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  One private key on a muted panel: label, description, and the value masked
  until revealed. Whoever holds the key decides how a reveal happens — the key
  card asks for an unlock first, the account deletion already has it in hand —
  so this only renders what it is given and reports the clicks.
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'

  import { Button } from '$lib/components/ui/button'
  import { toastStore } from '$lib/stores/toast.svelte'
  import { copyToClipboard } from '$lib/utils'

  const MASKED_KEY = '•'.repeat(66)

  interface Props {
    label: string
    description: string
    /** The key as shown; undefined keeps it masked. */
    value: string | undefined
    /** What the copy button copies — absent, there is no copy button. */
    copyValue: string | undefined
    onreveal: () => void
    /** Offered once revealed; without it a revealed key stays shown. */
    onhide?: () => void
  }

  let { label, description, value, copyValue, onreveal, onhide }: Props = $props()

  async function copy(text: string) {
    toastStore.show(
      (await copyToClipboard(text))
        ? `${label} copied to clipboard`
        : 'Could not copy to clipboard',
    )
  }
</script>

<div class="bg-muted flex flex-col gap-1 rounded-md p-4">
  <div class="flex flex-col">
    <p class="text-sm font-medium">{label}</p>
    <p class="text-muted-foreground text-xs">{description}</p>
  </div>
  <div class="flex items-center gap-2">
    {#if value}
      <p class="min-w-0 flex-1 text-sm break-all">{value}</p>
    {:else}
      <p class="min-w-0 flex-1 text-sm break-all select-none">{MASKED_KEY}</p>
    {/if}
    {#if !value}
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        aria-label="Reveal {label.toLowerCase()}"
        onclick={onreveal}
      >
        <Eye />
      </Button>
    {:else if onhide}
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        aria-label="Hide {label.toLowerCase()}"
        onclick={onhide}
      >
        <EyeOff />
      </Button>
    {/if}
    {#if copyValue}
      <Button
        variant="ghost"
        size="icon"
        class="size-7 shrink-0"
        aria-label="Copy {label.toLowerCase()}"
        onclick={() => copyValue && copy(copyValue)}
      >
        <Copy />
      </Button>
    {/if}
  </div>
</div>
