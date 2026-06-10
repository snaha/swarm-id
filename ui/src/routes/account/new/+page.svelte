<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { generateName } from '$lib/name-generator'
  import { sessionStore } from '$lib/stores/session.svelte'

  const IDENTICON_SIZE = 32

  let name = $state(sessionStore.draft?.name ?? generateName())

  function onContinue() {
    sessionStore.startDraft(name.trim())
    goto(resolve('/account/new/phrase'))
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-start gap-8">
      <Button
        variant="outline"
        size="icon"
        href={resolve('/')}
        aria-label="Go back"
        class="size-6 rounded-md [&_svg]:size-3"
      >
        <ChevronLeft />
      </Button>

      <div class="flex w-full flex-col">
        <h1 class="text-lg font-bold">New account</h1>
        <p class="text-sm">Create a new Swarm ID account.</p>
      </div>

      <div class="flex w-full flex-col gap-2">
        <label for="name" class="text-sm font-medium">Name</label>
        <div class="flex w-full items-center gap-2">
          <Input id="name" bind:value={name} placeholder="Jovial Einstein" />
          <Polycon value={name} size={IDENTICON_SIZE} class="shrink-0 overflow-hidden rounded-lg" />
        </div>
        <p class="text-muted-foreground text-xs">Identity displayed in connected apps.</p>
      </div>

      <Button class="w-full" disabled={name.trim().length === 0} onclick={onContinue}>
        Continue
      </Button>
    </div>
  </main>
</div>
