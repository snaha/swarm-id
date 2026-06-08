<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round'

  import { Button } from '$lib/components/ui/button'
</script>

<main class="flex min-h-svh flex-col items-center justify-center gap-6 p-6 text-center">
  <div class="flex items-center gap-3">
    <KeyRound class="size-8" />
    <h1 class="text-3xl font-semibold tracking-tight">Swarm Identity</h1>
  </div>

  <p class="text-muted-foreground max-w-md text-balance">
    The next-generation identity and key management UI for the Swarm network. Built with SvelteKit
    and shadcn-svelte.
  </p>

  <div class="flex flex-wrap items-center justify-center gap-3">
    <Button>Get started</Button>
    <Button variant="outline">Learn more</Button>
  </div>
</main>
