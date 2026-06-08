<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import Dices from '@lucide/svelte/icons/dices'

  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { generateName } from '$lib/name-generator'

  let name = $state(generateName())
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-start gap-8">
      <Button variant="ghost" size="icon" href={resolve('/')} aria-label="Go back">
        <ChevronLeft />
      </Button>

      <div class="flex w-full flex-col">
        <h1 class="text-lg font-bold">New account</h1>
        <p class="text-sm">Create a new Swarm ID account.</p>
      </div>

      <div class="flex w-full flex-col gap-2">
        <label for="name" class="text-sm font-medium">Name</label>
        <div class="flex w-full items-start gap-2">
          <Input id="name" bind:value={name} placeholder="Jovial Einstein" />
          <Button
            variant="outline"
            size="icon"
            aria-label="Suggest a random name"
            onclick={() => (name = generateName())}
          >
            <Dices />
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">Identity displayed in connected apps.</p>
      </div>

      <Button class="w-full" disabled={name.trim().length === 0}>Continue</Button>
    </div>
  </main>
</div>
