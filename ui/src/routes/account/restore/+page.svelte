<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { restoreBackup } from '$lib/crypto/backup'
  import { isValidPhrase, normalizePhrase } from '$lib/crypto/mnemonic'
  import { sessionStore } from '$lib/stores/session.svelte'

  let fileInput = $state<HTMLInputElement>()
  let fileName = $state<string | undefined>(undefined)
  let fileContents = $state<string | undefined>(undefined)
  let phrase = $state('')
  let restoring = $state(false)
  let failed = $state(false)

  const phraseValid = $derived(isValidPhrase(phrase))
  const showInvalid = $derived(phrase.trim().length > 0 && !phraseValid)
  const canRestore = $derived(fileContents !== undefined && phraseValid && !restoring)

  async function onFileSelected() {
    const file = fileInput?.files?.[0]
    if (!file) {
      return
    }
    fileName = file.name
    fileContents = await file.text()
  }

  function clearFile() {
    fileName = undefined
    fileContents = undefined
    if (fileInput) {
      fileInput.value = ''
    }
  }

  async function pasteFromClipboard() {
    try {
      phrase = await navigator.clipboard.readText()
    } catch {
      // Clipboard access denied or unavailable — the user can paste manually.
    }
  }

  async function restore() {
    if (!fileContents) {
      return
    }
    restoring = true
    try {
      const normalized = normalizePhrase(phrase)
      const restored = await restoreBackup(fileContents, normalized)
      sessionStore.startRestore(restored, normalized)
      await goto(resolve('/account/new/access'))
    } catch {
      failed = true
    } finally {
      restoring = false
    }
  }

  function tryAgain() {
    failed = false
    phrase = ''
    clearFile()
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  {#if failed}
    <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
      <div class="flex w-full max-w-96 flex-col items-center gap-8">
        <div class="flex flex-col items-center gap-2">
          <CircleAlert class="text-destructive size-5" />
          <div class="flex flex-col items-center text-center">
            <p class="text-sm font-bold">Restoring account failed</p>
            <p class="text-sm">Please double-check your secret recovery phrase.</p>
          </div>
        </div>
        <Button variant="secondary" class="w-full" onclick={tryAgain}>Try again</Button>
      </div>
    </main>
  {:else}
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
          <h1 class="text-lg font-bold">Restore account</h1>
          <p class="text-sm">
            Restore an account from a backup file and its secret recovery phrase.
          </p>
        </div>

        <input
          bind:this={fileInput}
          type="file"
          accept=".swarmid"
          class="hidden"
          onchange={onFileSelected}
        />
        {#if fileName}
          <div
            class="border-input flex h-8 w-full items-center gap-1.5 rounded-lg border px-2.5 text-sm"
          >
            <span class="flex-1 truncate">{fileName}</span>
            <Button
              variant="ghost"
              size="icon"
              class="size-5 rounded-md [&_svg]:size-3"
              aria-label="Remove file"
              onclick={clearFile}
            >
              <X />
            </Button>
          </div>
        {:else}
          <Button variant="secondary" class="w-full" onclick={() => fileInput?.click()}>
            <Upload />
            Select .swarmid file
          </Button>
        {/if}

        <div class="flex w-full flex-col gap-4">
          <div class="flex w-full flex-col gap-2">
            <p class="text-sm">Provide the account secret recovery phrase:</p>
            <Textarea
              bind:value={phrase}
              class="h-28"
              disabled={restoring}
              aria-invalid={showInvalid}
              placeholder="Add a space between each word and make sure no one is watching"
            />
            {#if showInvalid}
              <p class="text-destructive text-xs">Invalid phrase</p>
            {/if}
          </div>
          <div>
            <Button variant="ghost" size="xs" disabled={restoring} onclick={pasteFromClipboard}>
              Paste from clipboard
            </Button>
          </div>
        </div>

        <Button class="w-full" disabled={!canRestore} onclick={restore}>
          {#if restoring}
            <LoaderCircle class="animate-spin" />
            Restoring
          {:else}
            Restore
          {/if}
        </Button>
      </div>
    </main>
  {/if}
</div>
