<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import Eye from '@lucide/svelte/icons/eye'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import Toast from '$lib/components/toast.svelte'
  import { Alert } from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { Tabs } from '$lib/components/ui/tabs'
  import { Textarea } from '$lib/components/ui/textarea'
  import { generatePhrase, isValidPhrase, normalizePhrase } from '$lib/crypto/mnemonic'
  import { sessionStore } from '$lib/stores/session.svelte'

  const TOAST_DURATION_MS = 4000
  const TABS = [
    { value: 'generate', label: 'Generate' },
    { value: 'import', label: 'Import' },
  ]

  // Reuse the draft phrase so navigating back does not regenerate it.
  const generated = sessionStore.draft?.phrase ?? generatePhrase()
  const words = generated.split(' ')

  let mode = $state('generate')
  let revealed = $state(false)
  let imported = $state('')
  let toastMessage = $state<string | undefined>(undefined)
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const importedValid = $derived(isValidPhrase(imported))
  const canContinue = $derived(mode === 'generate' ? revealed : importedValid)
  const showImportError = $derived(
    mode === 'import' && imported.trim().length > 0 && !importedValid,
  )

  onMount(() => {
    if (!sessionStore.draft) {
      goto(resolve('/account/new'))
    }
  })

  function showToast(message: string) {
    toastMessage = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastMessage = undefined), TOAST_DURATION_MS)
  }

  async function copyPhrase() {
    await navigator.clipboard.writeText(generated)
    showToast('Seed phrase copied to clipboard')
  }

  function downloadPhrase() {
    const blob = new Blob([generated], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'swarm-id-recovery-phrase.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function pasteFromClipboard() {
    try {
      imported = await navigator.clipboard.readText()
    } catch {
      // Clipboard access denied or unavailable — the user can paste manually.
    }
  }

  function onContinue() {
    sessionStore.setDraftPhrase(mode === 'generate' ? generated : normalizePhrase(imported))
    goto(resolve('/account/new/access'))
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-start gap-8">
      <Button
        variant="outline"
        size="icon"
        href={resolve('/account/new')}
        aria-label="Go back"
        class="size-6 rounded-md [&_svg]:size-3"
      >
        <ChevronLeft />
      </Button>

      <div class="flex w-full flex-col">
        <h1 class="text-lg font-bold">Secret recovery phrase</h1>
        <p class="text-sm">
          Needed to sign in to your account on another device or restore it here if you lose access.
        </p>
      </div>

      <div class="flex w-full flex-col gap-4">
        <Tabs tabs={TABS} bind:value={mode} />

        {#if mode === 'generate'}
          <div class="flex w-full flex-col gap-2">
            {#if revealed}
              <div class="grid w-full grid-cols-3 gap-2">
                {#each words as word, index (index)}
                  <div
                    class="border-input flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm"
                  >
                    <span class="text-muted-foreground">{index + 1}.</span>
                    <span class="truncate">{word}</span>
                  </div>
                {/each}
              </div>
            {:else}
              <div
                class="border-input flex h-38 w-full flex-col items-center justify-center gap-2 rounded-lg border"
              >
                <Button variant="outline" size="sm" onclick={() => (revealed = true)}>
                  <Eye />
                  Reveal
                </Button>
                <p class="text-muted-foreground text-xs">
                  Make sure no one is watching your screen.
                </p>
              </div>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="xs" onclick={copyPhrase}>Copy</Button>
            <Button variant="ghost" size="xs" onclick={downloadPhrase}>Download</Button>
          </div>
        {:else}
          <div class="flex w-full flex-col gap-2">
            <Textarea
              bind:value={imported}
              class="h-38"
              aria-invalid={showImportError}
              placeholder="Add a space between each word and make sure no one is watching"
            />
            {#if showImportError}
              <p class="text-destructive text-xs">Invalid phrase</p>
            {/if}
          </div>
          <div>
            <Button variant="ghost" size="xs" onclick={pasteFromClipboard}>
              Paste from clipboard
            </Button>
          </div>
        {/if}
      </div>

      <Alert>
        <span class="font-bold">Save your secret recovery phrase in a safe place.</span><br />
        If someone has it, they can access your account.
      </Alert>

      <Button class="w-full" disabled={!canContinue} onclick={onContinue}>Continue</Button>
    </div>
  </main>

  <Toast message={toastMessage} />
</div>
