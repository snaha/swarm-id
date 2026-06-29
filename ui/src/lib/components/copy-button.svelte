<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'

  import { Button } from '$lib/components/ui/button'
  import { copyToClipboard } from '$lib/utils'

  const FEEDBACK_DURATION_MS = 2000

  let { text }: { text: string } = $props()

  let copied = $state(false)
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  async function handleCopy() {
    const ok = await copyToClipboard(text)
    if (!ok) return
    copied = true
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => (copied = false), FEEDBACK_DURATION_MS)
  }
</script>

<Button variant="ghost" size="xs" aria-label="Copy" onclick={handleCopy}>
  {#if copied}
    <Check />
  {:else}
    <Copy />
  {/if}
</Button>
