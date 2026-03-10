<script lang="ts">
  import { cn } from '$lib/utils'
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
