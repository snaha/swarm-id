<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import type { Snippet } from 'svelte'

  import { cn } from '$lib/utils'

  interface Props {
    class?: string
    children: Snippet
  }

  let { class: className, children }: Props = $props()
</script>

<div role="note" class={cn('w-full rounded-lg border p-2 text-center text-xs', className)}>
  {@render children()}
</div>
