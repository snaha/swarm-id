<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'

  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'

  let phrase = $state('')

  async function pasteFromClipboard() {
    try {
      phrase = await navigator.clipboard.readText()
    } catch {
      // Clipboard access denied or unavailable — the user can paste manually.
    }
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-start gap-8">
      <Button variant="ghost" size="icon" href={resolve('/')} aria-label="Go back">
        <ChevronLeft />
      </Button>

      <div class="flex w-full flex-col">
        <h1 class="text-lg font-bold">Existing account</h1>
        <p class="text-sm">
          Paste the secret recovery phrase to set up an existing Swarm ID account on this device.
        </p>
      </div>

      <div class="flex w-full flex-col gap-4">
        <Textarea
          bind:value={phrase}
          class="h-38"
          placeholder="Add a space between each word and make sure no one is watching"
        />
        <div>
          <Button variant="ghost" size="xs" onclick={pasteFromClipboard}>
            Paste from clipboard
          </Button>
        </div>
      </div>

      <Button class="w-full" disabled={phrase.trim().length === 0}>Continue</Button>
    </div>
  </main>
</div>
