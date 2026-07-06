<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { EthAddress } from '@ethersphere/bee-js'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { generatePhrase, walletFromPhrase } from '$lib/crypto/mnemonic'
  import { generateDockerName } from '$lib/docker-name'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'

  const IDENTICON_SIZE = 32

  // Generate the recovery phrase up front so the default name and identicon can
  // derive deterministically from the resulting account id (the address) — the
  // same id/name every device sees for this phrase. Reuse the draft phrase so
  // navigating back does not regenerate it.
  const phrase = sessionStore.draft?.phrase ?? generatePhrase()
  const accountId = new EthAddress(walletFromPhrase(phrase).address).toHex()
  const defaultName = generateDockerName(accountId)

  let name = $state(sessionStore.draft?.name ?? defaultName)

  function onContinue() {
    const trimmed = name.trim()
    sessionStore.startDraft(trimmed, phrase, trimmed !== defaultName)
    goto(resolve(routes.ACCOUNT_NEW_PHRASE))
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

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
        <h1 class="text-lg font-bold">New account</h1>
        <p class="text-sm">Choose a name. The identicon is generated from your account.</p>
      </div>

      <div class="flex w-full flex-col gap-2">
        <label for="name" class="text-sm font-medium">Name</label>
        <div class="flex w-full items-center gap-2">
          <Input id="name" bind:value={name} placeholder={defaultName} />
          <Polycon
            value={accountId}
            size={IDENTICON_SIZE}
            class="shrink-0 overflow-hidden rounded-lg"
          />
        </div>
        <p class="text-muted-foreground text-xs">This is how you'll appear in connected apps.</p>
      </div>

      <Button class="w-full" disabled={name.trim().length === 0} onclick={onContinue}>
        Continue
      </Button>
    </div>
  </main>
</div>
