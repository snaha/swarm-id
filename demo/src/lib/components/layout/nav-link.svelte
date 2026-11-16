<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { page } from '$app/state'
  import { resolve } from '$app/paths'
  import type { RouteId } from '$app/types'
  import { cn } from '$lib/utils'
  import { sidebarStore } from '$lib/stores/sidebar.svelte'

  interface Props {
    href: RouteId
    label: string
  }

  let { href, label }: Props = $props()

  const isActive = $derived(
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href),
  )
</script>

<a
  href={resolve(href)}
  onclick={() => sidebarStore.closeMobile()}
  class={cn(
    'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  )}
>
  {label}
</a>
