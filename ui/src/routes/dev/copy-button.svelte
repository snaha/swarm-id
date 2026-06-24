<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'

  import { Button } from '$lib/components/ui/button'
  import { copyToClipboard } from '$lib/utils'

  const COPIED_RESET_MS = 1500

  let { text }: { text: string } = $props()

  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function copy() {
    if (!(await copyToClipboard(text))) {
      return
    }
    copied = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied = false), COPIED_RESET_MS)
  }
</script>

<Button
  variant="ghost"
  size="icon"
  class="size-6 [&_svg]:size-3.5"
  aria-label="Copy"
  onclick={copy}
>
  {#if copied}
    <Check class="text-success" />
  {:else}
    <Copy />
  {/if}
</Button>
