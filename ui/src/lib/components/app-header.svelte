<script lang="ts">
  import SwarmWordmark from './swarm-wordmark.svelte'
  import ThemeToggle from './theme-toggle.svelte'
</script>

<header class="flex w-full items-center gap-2 p-8">
  <SwarmWordmark />
  <div class="flex flex-1 items-center justify-end">
    <ThemeToggle />
  </div>
</header>
