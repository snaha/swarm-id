<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Bee, EthAddress } from '@ethersphere/bee-js'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import {
    type AccountData,
    deriveAccountDerivationKey,
    foldAccountFromSwarm,
  } from '@snaha/swarm-id'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { completeConnect } from '$lib/connect-handshake'
  import { strip0x } from '$lib/crypto/hex'
  import { isValidPhrase, normalizePhrase, walletFromPhrase } from '$lib/crypto/mnemonic'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  let phrase = $state('')
  let signingIn = $state(false)
  let failed = $state(false)
  let failureMessage = $state<string | undefined>(undefined)

  const phraseValid = $derived(isValidPhrase(phrase))
  const showInvalid = $derived(phrase.trim().length > 0 && !phraseValid)

  async function signIn() {
    signingIn = true
    try {
      const normalized = normalizePhrase(phrase)
      const wallet = walletFromPhrase(normalized)

      // Already set up on this device — just switch to it.
      const existing = accountsStore.get(wallet.address)
      if (existing) {
        sessionStore.setCurrentAccount(existing.id)

        // Came from a dApp connect popup — the phrase already unlocked the
        // account, so finish the handshake right away.
        const request = connectStore.request
        if (request) {
          await completeConnect(existing, wallet.entropy, request)
          await goto(resolve(routes.CONNECT_DONE))
          return
        }

        sessionStore.setCompletedFlow('sign-in')
        await goto(resolve(routes.ACCOUNT_READY))
        return
      }

      // New device: verify the account exists on Swarm before creating it
      // locally, and recover its synced state (name/stamps/apps). Reading the
      // network here is what turns a mistyped phrase into a clear "not found"
      // instead of a silent empty account.
      const derivationKey = await deriveAccountDerivationKey(strip0x(wallet.privateKey))
      const bee = new Bee(networkSettingsStore.beeNodeUrl)

      // The fold's roster reader swallows read failures into an empty roster, so
      // it can't by itself tell "no account" from "network down". Probe
      // reachability first so an offline node surfaces as an error to retry, not
      // a false "account not found".
      if (!(await bee.isConnected())) {
        failed = true
        failureMessage = "Couldn't reach the Swarm network. Check your connection and try again."
        return
      }

      const accountId = new EthAddress(wallet.address).toHex()
      const folded = await foldAccountFromSwarm({ bee, derivationKey, accountId })
      if (!folded) {
        // No account has been published under this phrase — the default copy
        // renders the "double-check your phrase" screen.
        failed = true
        failureMessage = undefined
        return
      }

      // Recover the synced state so `finalize` rebuilds the real account rather
      // than a fresh empty one. The fold freezes its arrays — copy them since
      // downstream mutates in place.
      const { account: state } = folded
      const restored: AccountData = {
        id: new EthAddress(wallet.address),
        name: state.accountName,
        publicKey: state.publicKey,
        createdAt: state.createdAt,
        derivationKey,
        defaultPostageStampBatchID: state.defaultPostageStampBatchID,
        settings: state.settings,
        accountNameAt: state.accountNameAt,
        defaultStampAt: state.defaultStampAt,
        settingsAt: state.settingsAt,
        lastModified: Date.now(),
        devices: [...state.devices],
        connectedApps: [...state.connectedApps],
        postageStamps: [...state.postageStamps],
        partitionCount: state.partitionCount,
      }

      sessionStore.startSignIn(state.accountName, normalized, restored)
      await goto(resolve(routes.ACCOUNT_NEW_ACCESS))
    } catch (caught) {
      // The phrase was checksum-validated before the button enabled, so a
      // failure here is the connect handshake or the network fold — surface the
      // message (the "error/retry" bucket, not a false "not found").
      failed = true
      failureMessage = caught instanceof Error ? caught.message : undefined
    } finally {
      signingIn = false
    }
  }

  function tryAgain() {
    failed = false
    failureMessage = undefined
    phrase = ''
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
            <p class="text-sm font-bold">Sign in failed</p>
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
          <h1 class="text-lg font-bold">Existing account</h1>
          <p class="text-sm">
            Enter your secret recovery phrase to sign in to your Swarm ID account on this device.
          </p>
        </div>

        <div class="flex w-full flex-col gap-2">
          <Textarea
            bind:value={phrase}
            class="h-38"
            disabled={signingIn}
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

        <Button class="w-full" disabled={!phraseValid || signingIn} onclick={signIn}>
          {#if signingIn}
            <LoaderCircle class="animate-spin" />
            Signing in
          {:else}
            Sign in
          {/if}
        </Button>
      </div>
    </main>
  {/if}
</div>
