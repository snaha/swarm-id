<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  interface Props {
    words: string[]
  }

  let { words }: Props = $props()
</script>

<div class="grid w-full grid-cols-3 gap-2">
  {#each words as word, index (index)}
    <div class="border-input flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm">
      <span class="text-muted-foreground">{index + 1}.</span>
      <span class="truncate">{word}</span>
    </div>
  {/each}
</div>
