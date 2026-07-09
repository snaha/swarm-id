<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { cn } from '$lib/utils'
  import { resolveProxyOrigin } from '$lib/utils/environment'
  import { sidebarStore } from '$lib/stores/sidebar.svelte'
  import NavLink from './nav-link.svelte'
  import SidebarAuth from './sidebar-auth.svelte'
  import SidebarStamp from './sidebar-stamp.svelte'

  const NAV_ITEMS = [
    { href: '/', label: 'Home' },
    { href: '/storage', label: 'Storage' },
    { href: '/access-control', label: 'Access Control' },
    { href: '/soc', label: 'SOC' },
    { href: '/feeds', label: 'Feeds' },
    { href: '/account', label: 'Account' },
  ]
</script>

<aside
  class={cn(
    'fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-border bg-muted transition-transform duration-200',
    'md:relative md:translate-x-0',
    sidebarStore.mobileOpen ? 'translate-x-0' : '-translate-x-full',
  )}
>
  <!-- App title -->
  <div class="border-b border-border p-4">
    <h1 class="text-lg font-bold text-foreground">Swarm ID Demo</h1>
    <p class="text-xs text-muted-foreground">Identity & Data Primitives</p>
  </div>

  <!-- Navigation -->
  <nav class="flex-1 overflow-y-auto p-3 space-y-1">
    {#each NAV_ITEMS as item (item.href)}
      <NavLink href={item.href} label={item.label} />
    {/each}
    <!-- external URL, not an app route -->
    <!-- eslint-disable svelte/no-navigation-without-resolve -->
    <a
      href={resolveProxyOrigin()}
      target="_blank"
      rel="noopener noreferrer"
      class="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      SwarmID
      <svg
        class="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      </svg>
    </a>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </nav>

  <!-- Auth section -->
  <div class="border-t border-border p-3">
    <SidebarAuth />
  </div>

  <!-- Stamp summary -->
  <div class="border-t border-border p-3">
    <SidebarStamp />
  </div>
</aside>
