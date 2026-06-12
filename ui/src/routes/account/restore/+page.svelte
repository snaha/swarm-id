<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import FileText from '@lucide/svelte/icons/file-text'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { isBackupFile, isLegacyBackupFile, restoreBackup } from '$lib/crypto/backup'
  import { isValidPhrase, normalizePhrase } from '$lib/crypto/mnemonic'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'

  let fileInput = $state<HTMLInputElement>()
  let fileName = $state<string | undefined>(undefined)
  let fileContents = $state<string | undefined>(undefined)
  let fileError = $state<string | undefined>(undefined)
  let phrase = $state('')
  let restoring = $state(false)
  let failed = $state(false)
  let failureMessage = $state<string | undefined>(undefined)

  const phraseValid = $derived(isValidPhrase(phrase))
  const showInvalid = $derived(phrase.trim().length > 0 && !phraseValid)
  const canRestore = $derived(fileContents !== undefined && phraseValid && !restoring)

  async function onFileSelected() {
    const file = fileInput?.files?.[0]
    if (!file) {
      return
    }
    const contents = await file.text()
    if (!isBackupFile(contents)) {
      clearFile()
      fileError = isLegacyBackupFile(contents)
        ? 'This backup is from the previous Swarm ID app and cannot be restored here. Sign in with your secret recovery phrase instead.'
        : 'Invalid backup file'
      return
    }
    fileError = undefined
    fileName = file.name
    fileContents = contents
  }

  function clearFile() {
    fileName = undefined
    fileContents = undefined
    if (fileInput) {
      fileInput.value = ''
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
      await goto(resolve(routes.ACCOUNT_NEW_ACCESS))
    } catch (caught) {
      failed = true
      failureMessage = caught instanceof Error ? caught.message : undefined
    } finally {
      restoring = false
    }
  }

  function tryAgain() {
    failed = false
    failureMessage = undefined
    fileError = undefined
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
            <p class="text-sm">
              {failureMessage ?? 'Please double-check your secret recovery phrase.'}
            </p>
          </div>
        </div>
        <Button variant="outline" class="w-full" onclick={tryAgain}>Try again</Button>
      </div>
    </main>
  {:else}
    <main class="flex w-full flex-1 flex-col items-center px-8">
      <div class="flex w-full max-w-96 flex-col items-start gap-8">
        <Button
          variant="outline"
          size="icon"
          href={resolve(routes.ROOT)}
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
          <div class="border-border flex h-12 w-full items-center gap-2 rounded-lg border px-4">
            <FileText class="size-4 shrink-0" />
            <span class="flex-1 truncate text-sm font-medium">{fileName}</span>
            <Button
              variant="ghost"
              size="icon"
              class="-mr-2"
              aria-label="Remove file"
              onclick={clearFile}
            >
              <X />
            </Button>
          </div>
        {:else}
          <div class="flex w-full flex-col gap-2">
            <Button variant="secondary" class="w-full" onclick={() => fileInput?.click()}>
              <Upload />
              Select .swarmid file
            </Button>
            {#if fileError}
              <p class="text-destructive flex items-center gap-1.5 text-xs">
                <CircleAlert class="size-3.5 shrink-0" />
                {fileError}
              </p>
            {/if}
          </div>
        {/if}

        <div class="flex w-full flex-col gap-2">
          <label for="restore-phrase" class="text-sm font-medium">Secret recovery phrase</label>
          <Textarea
            id="restore-phrase"
            bind:value={phrase}
            class="h-38"
            disabled={restoring}
            aria-invalid={showInvalid}
            placeholder="Add a space between each word and make sure no one is watching"
          />
          {#if showInvalid}
            <p class="text-destructive flex items-center gap-1.5 text-xs">
              <CircleAlert class="size-3.5" />
              Invalid phrase
            </p>
          {/if}
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
