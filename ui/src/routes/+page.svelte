<script lang="ts">
  import { resolve } from '$app/paths'

  import SwarmWordmark from '$lib/components/swarm-wordmark.svelte'
  import ThemeToggle from '$lib/components/theme-toggle.svelte'
  import { Button } from '$lib/components/ui/button'
</script>

<div class="relative flex min-h-svh flex-col items-center justify-center p-8">
  <div class="absolute top-8 right-8">
    <ThemeToggle />
  </div>

  <div class="flex w-full max-w-96 flex-col items-center gap-8">
    <SwarmWordmark height={36} />

    <div class="flex w-full flex-col items-center gap-4">
      <Button class="w-full" href={resolve('/account/new')}>Create a new account</Button>
      <Button variant="secondary" class="w-full" href={resolve('/account/import')}>
        I already have an account
      </Button>
    </div>

    <Button variant="ghost" size="xs">Network settings</Button>
  </div>
</div>
