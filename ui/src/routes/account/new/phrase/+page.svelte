<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import Copy from '@lucide/svelte/icons/copy'
  import Download from '@lucide/svelte/icons/download'
  import Eye from '@lucide/svelte/icons/eye'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import PhraseGrid from '$lib/components/phrase-grid.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Tabs } from '$lib/components/ui/tabs'
  import { Textarea } from '$lib/components/ui/textarea'
  import { generatePhrase, isValidPhrase, normalizePhrase } from '$lib/crypto/mnemonic'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import { copyToClipboard } from '$lib/utils'

  const TABS = [
    { value: 'generate', label: 'Generate' },
    { value: 'import', label: 'Import' },
  ]

  // Reuse the draft phrase so navigating back does not regenerate it.
  const generated = sessionStore.draft?.phrase ?? generatePhrase()
  const words = generated.split(' ')

  let mode = $state('generate')
  let revealed = $state(false)
  // The user had a chance to save the phrase (revealed, copied, or downloaded).
  let phraseAccessed = $state(false)
  let imported = $state('')

  const importedValid = $derived(isValidPhrase(imported))
  const canContinue = $derived(mode === 'generate' ? phraseAccessed : importedValid)
  const showImportError = $derived(
    mode === 'import' && imported.trim().length > 0 && !importedValid,
  )

  onMount(() => {
    if (!sessionStore.draft) {
      goto(resolve(routes.ACCOUNT_NEW))
    }
  })

  function reveal() {
    revealed = true
    phraseAccessed = true
  }

  async function copyPhrase() {
    phraseAccessed = true
    if (await copyToClipboard(generated)) {
      toastStore.show('Seed phrase copied to clipboard')
    } else {
      toastStore.show('Could not copy to clipboard')
    }
  }

  function downloadPhrase() {
    phraseAccessed = true
    const blob = new Blob([generated], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'swarm-id-recovery-phrase.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function onContinue() {
    sessionStore.setDraftPhrase(mode === 'generate' ? generated : normalizePhrase(imported))
    goto(resolve(routes.ACCOUNT_NEW_ACCESS))
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  <main class="flex w-full flex-1 flex-col items-center px-8">
    <div class="flex w-full max-w-96 flex-col items-start gap-8">
      <Button
        variant="outline"
        size="icon"
        href={resolve(routes.ACCOUNT_NEW)}
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
              <PhraseGrid {words} />
            {:else}
              <div
                class="border-input flex h-38 w-full flex-col items-center justify-center gap-2 rounded-lg border"
              >
                <Button variant="ghost" onclick={reveal}>
                  <Eye />
                  Reveal
                </Button>
                <p class="text-muted-foreground text-xs">
                  Make sure no one is watching your screen.
                </p>
              </div>
            {/if}
          </div>
          <div class="flex w-full items-center gap-4">
            <div class="flex items-center gap-2">
              <Button variant="outline" size="icon" aria-label="Copy phrase" onclick={copyPhrase}>
                <Copy />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Download phrase"
                onclick={downloadPhrase}
              >
                <Download />
              </Button>
            </div>
            <p class="text-muted-foreground flex-1 text-xs">
              Save in a safe place. If someone has it, they can access your account.
            </p>
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
              <p class="text-destructive flex items-center gap-1.5 text-xs">
                <CircleAlert class="size-3.5" />
                Invalid phrase
              </p>
            {/if}
          </div>
        {/if}
      </div>

      <Button class="w-full" disabled={!canContinue} onclick={onContinue}>Continue</Button>
    </div>
  </main>
</div>
