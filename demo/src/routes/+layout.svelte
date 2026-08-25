<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import '../app.css'
  import { onMount, onDestroy } from 'svelte'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { sidebarStore } from '$lib/stores/sidebar.svelte'
  import Sidebar from '$lib/components/layout/sidebar.svelte'
  import MobileMenuButton from '$lib/components/layout/mobile-menu-button.svelte'
  import ConsolePanel from '$lib/components/layout/console-panel.svelte'
  import StoragePartitionedBanner from '$lib/components/storage-partitioned-banner.svelte'

  let { children } = $props()

  onMount(() => {
    logStore.log('Demo application starting...')
    clientStore.initialize()
  })

  onDestroy(() => {
    clientStore.destroy()
  })
</script>

<div class="flex h-screen overflow-hidden">
  <!-- Sidebar -->
  <Sidebar />

  <!-- Mobile overlay backdrop -->
  {#if sidebarStore.mobileOpen}
    <button
      class="fixed inset-0 z-40 bg-black/50 md:hidden"
      onclick={() => sidebarStore.closeMobile()}
      aria-label="Close navigation"
    ></button>
  {/if}

  <!-- Main area -->
  <div class="flex flex-1 flex-col overflow-hidden">
    <!-- Mobile header -->
    <header class="flex items-center gap-3 border-b border-border p-4 md:hidden">
      <MobileMenuButton />
      <span class="text-lg font-bold text-foreground">Swarm ID Demo</span>
    </header>

    <!-- Scrollable page content -->
    <main class="flex-1 overflow-y-auto p-6 md:p-10">
      <div class="mx-auto max-w-[800px] space-y-6">
        <!-- Partitioned storage is no longer read-only by itself: a hydrated
             session uploads with the account's own stamps. Warn only when
             uploads are genuinely unavailable. -->
        {#if clientStore.storagePartitioned && clientStore.authenticated && !clientStore.canUpload}
          <StoragePartitionedBanner />
        {/if}
        {@render children()}
      </div>
    </main>

    <!-- Console panel -->
    <ConsolePanel />
  </div>
</div>
