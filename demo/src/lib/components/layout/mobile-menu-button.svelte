<script lang="ts">
  import { sidebarStore } from '$lib/stores/sidebar.svelte'
</script>

<button
  onclick={() => sidebarStore.toggleMobile()}
  class="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
  aria-label="Toggle navigation menu"
>
  <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
    {#if sidebarStore.mobileOpen}
      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
    {:else}
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    {/if}
  </svg>
</button>
