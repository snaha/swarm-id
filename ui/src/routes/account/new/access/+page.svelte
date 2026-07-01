<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'

  import { EthAddress } from '@ethersphere/bee-js'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { PARTITION_COUNT, deriveAccountDerivationKey } from '@snaha/swarm-id'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Tabs } from '$lib/components/ui/tabs'
  import { completeConnect } from '$lib/connect-handshake'
  import {
    PASSWORD_KDF_ITERATIONS,
    deriveKeyFromPassword,
    encryptSeed,
    randomSalt,
  } from '$lib/crypto/encryption'
  import { deriveWalletKey, requestWalletKeySource } from '$lib/crypto/eth-wallet'
  import { bytesToHex } from '$lib/crypto/hex'
  import { privateKeyFromEntropy, walletFromPhrase } from '$lib/crypto/mnemonic'
  import { createPasskeyKey } from '$lib/crypto/passkey'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { AccessMethod, AccountRecord } from '$lib/types'
  import { bareHex } from '$lib/utils'

  const MIN_PASSWORD_LENGTH = 8
  const TABS = [
    { value: 'passkey', label: 'Passkey' },
    { value: 'eth-wallet', label: 'ETH wallet' },
    { value: 'password', label: 'Password' },
  ]

  let method = $state('passkey')
  let pending = $state<'passkey' | 'eth-wallet' | undefined>(undefined)
  let busy = $state(false)
  let error = $state<string | undefined>(undefined)

  let password = $state('')
  let verifyPassword = $state('')
  let showPassword = $state(false)
  let showVerifyPassword = $state(false)

  let abortController: AbortController | undefined
  /** Bumped on cancel/retry — a stale ceremony resolution must not finalize. */
  let attempt = 0

  const passwordTooShort = $derived(password.length > 0 && password.length < MIN_PASSWORD_LENGTH)
  const passwordMismatch = $derived(verifyPassword.length > 0 && password !== verifyPassword)
  const passwordValid = $derived(
    password.length >= MIN_PASSWORD_LENGTH && password === verifyPassword,
  )

  const backHref = $derived(
    sessionStore.draft?.flow === 'sign-in'
      ? resolve(routes.ACCOUNT_IMPORT)
      : sessionStore.draft?.flow === 'restore'
        ? resolve(routes.ACCOUNT_RESTORE)
        : resolve(routes.ACCOUNT_NEW_PHRASE),
  )

  onMount(() => {
    if (!sessionStore.draft?.phrase) {
      goto(resolve(routes.ACCOUNT_NEW))
    }
  })

  async function finalize(access: AccessMethod, key: CryptoKey) {
    const draft = sessionStore.draft
    if (!draft?.phrase) {
      return
    }
    const wallet = walletFromPhrase(draft.phrase)
    // Carry over data from a restore, or from an existing record for the same
    // address — re-importing a phrase must not wipe stamps or connected apps.
    const carried = draft.restored ?? accountsStore.get(wallet.address)
    // The derivation key is computed from the master key (the wallet private
    // key) while the entropy is in hand — the same chain the proxy/sync use.
    const masterKey = bareHex(privateKeyFromEntropy(wallet.entropy))
    const account: AccountRecord = {
      id: new EthAddress(bareHex(wallet.address)),
      name: draft.name,
      publicKey: bareHex(wallet.publicKey),
      createdAt: carried?.createdAt ?? Date.now(),
      derivationKey: await deriveAccountDerivationKey(masterKey),
      access,
      encryptedSeed: await encryptSeed(wallet.entropy, key),
      settings: carried?.settings,
      defaultPostageStampBatchID: carried?.defaultPostageStampBatchID,
      devices: carried?.devices ?? [],
      connectedApps: carried?.connectedApps ?? [],
      postageStamps: carried?.postageStamps ?? [],
      partitionCount: carried?.partitionCount ?? PARTITION_COUNT,
    }
    // `add` returns the live reactive account; the handshake mutates it.
    const liveAccount = accountsStore.add(account)
    sessionStore.setCurrentAccount(liveAccount.id)
    const flow = draft.flow

    // Came from a dApp connect popup — finish the handshake and hand back.
    // The draft is cleared only once the handshake succeeded, so a failure
    // leaves the Confirm buttons functional for a retry.
    const request = connectStore.request
    if (request) {
      await completeConnect(liveAccount, wallet.entropy, request)
      sessionStore.setCompletedFlow(flow)
      sessionStore.clearDraft()
      goto(resolve(routes.CONNECT_DONE))
      return
    }

    sessionStore.setCompletedFlow(flow)
    sessionStore.clearDraft()
    goto(resolve(flow === 'create' ? routes.ACCOUNT_NEW_DONE : routes.ACCOUNT_READY))
  }

  async function confirmWithPasskey() {
    const draft = sessionStore.draft
    if (!draft) {
      return
    }
    const myAttempt = ++attempt
    error = undefined
    pending = 'passkey'
    abortController = new AbortController()
    try {
      const passkey = await createPasskeyKey(draft.name, abortController.signal)
      if (myAttempt !== attempt) {
        return
      }
      await finalize({ type: 'passkey', credentialId: passkey.credentialId }, passkey.key)
    } catch (caught) {
      if (myAttempt === attempt) {
        error = caught instanceof Error ? caught.message : 'Passkey creation failed.'
      }
    } finally {
      if (myAttempt === attempt) {
        pending = undefined
      }
    }
  }

  async function confirmWithWallet() {
    const myAttempt = ++attempt
    error = undefined
    pending = 'eth-wallet'
    try {
      const source = await requestWalletKeySource()
      if (myAttempt !== attempt) {
        return
      }
      const salt = randomSalt()
      const key = await deriveWalletKey(source, salt)
      await finalize(
        {
          type: 'eth-wallet',
          encryptionSalt: bytesToHex(salt),
        },
        key,
      )
    } catch (caught) {
      if (myAttempt === attempt) {
        error = caught instanceof Error ? caught.message : 'Wallet signing failed.'
      }
    } finally {
      if (myAttempt === attempt) {
        pending = undefined
      }
    }
  }

  async function confirmWithPassword() {
    if (busy) {
      return
    }
    error = undefined
    busy = true
    try {
      const salt = randomSalt()
      const key = await deriveKeyFromPassword(password, salt)
      await finalize(
        { type: 'password', kdfSalt: bytesToHex(salt), kdfIterations: PASSWORD_KDF_ITERATIONS },
        key,
      )
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Encryption failed.'
    } finally {
      busy = false
    }
  }

  function cancelPending() {
    // Invalidate the in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not finalize.
    attempt++
    abortController?.abort()
    pending = undefined
  }
</script>

<div class="flex min-h-svh flex-col items-center">
  <AppHeader />

  {#if pending}
    <main class="flex w-full flex-1 flex-col items-center justify-center px-8 pb-24">
      <div class="flex w-full max-w-96 flex-col items-center gap-8">
        <div class="flex flex-col items-center gap-2">
          <LoaderCircle class="size-5 animate-spin" />
          <div class="flex flex-col items-center text-center">
            <p class="text-sm font-bold">
              {pending === 'passkey' ? 'Confirm with passkey' : 'Confirm with wallet'}
            </p>
            <p class="text-sm">
              {pending === 'passkey'
                ? 'Follow the prompts on your device.'
                : 'Approve the request in your Ethereum wallet.'}
            </p>
          </div>
        </div>
        <Button variant="outline" class="w-full" onclick={cancelPending}>Cancel</Button>
      </div>
    </main>
  {:else}
    <main class="flex w-full flex-1 flex-col items-center px-8">
      <div class="flex w-full max-w-96 flex-col items-start gap-8">
        <Button
          variant="outline"
          size="icon"
          href={backHref}
          aria-label="Go back"
          class="size-6 rounded-md [&_svg]:size-3"
        >
          <ChevronLeft />
        </Button>

        <div class="flex w-full flex-col">
          <h1 class="text-lg font-bold">Access security</h1>
          <p class="text-sm">Choose how to unlock your Swarm ID account on this device.</p>
        </div>

        <div class="flex w-full flex-col gap-8">
          <div class="flex w-full flex-col gap-4">
            <Tabs tabs={TABS} bind:value={method} />

            {#if method === 'passkey'}
              <p class="text-sm">
                Unlock with your device&rsquo;s built-in authentication &mdash; fingerprint, face,
                or PIN.
              </p>
            {:else if method === 'eth-wallet'}
              <p class="text-sm">Unlock by signing a message with your Ethereum wallet.</p>
            {/if}
          </div>

          {#if method === 'password'}
            <div class="flex w-full flex-col gap-4">
              <div class="flex w-full flex-col gap-2">
                <label for="new-password" class="text-sm font-medium">Create new password</label>
                <div class="flex w-full items-center gap-2">
                  <Input
                    id="new-password"
                    type={showPassword ? 'text' : 'password'}
                    bind:value={password}
                    autocomplete="new-password"
                    aria-invalid={passwordTooShort}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-6 shrink-0 rounded-md [&_svg]:size-3.5"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onclick={() => (showPassword = !showPassword)}
                  >
                    {#if showPassword}
                      <EyeOff />
                    {:else}
                      <Eye />
                    {/if}
                  </Button>
                </div>
                <p
                  class={passwordTooShort
                    ? 'text-destructive text-xs'
                    : 'text-muted-foreground text-xs'}
                >
                  Must be at least {MIN_PASSWORD_LENGTH} characters
                </p>
              </div>

              <div class="flex w-full flex-col gap-2">
                <label for="verify-password" class="text-sm font-medium">Verify password</label>
                <div class="flex w-full items-center gap-2">
                  <Input
                    id="verify-password"
                    type={showVerifyPassword ? 'text' : 'password'}
                    bind:value={verifyPassword}
                    autocomplete="new-password"
                    aria-invalid={passwordMismatch}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-6 shrink-0 rounded-md [&_svg]:size-3.5"
                    aria-label={showVerifyPassword ? 'Hide password' : 'Show password'}
                    onclick={() => (showVerifyPassword = !showVerifyPassword)}
                  >
                    {#if showVerifyPassword}
                      <EyeOff />
                    {:else}
                      <Eye />
                    {/if}
                  </Button>
                </div>
                {#if passwordMismatch}
                  <p class="text-destructive text-xs">Passwords do not match</p>
                {/if}
              </div>
            </div>
          {/if}

          {#if error}
            <p class="text-destructive w-full text-xs">{error}</p>
          {/if}

          {#if method === 'passkey'}
            <Button class="w-full" onclick={confirmWithPasskey}>Confirm with passkey</Button>
          {:else if method === 'eth-wallet'}
            <Button class="w-full" onclick={confirmWithWallet}>Confirm with wallet</Button>
          {:else}
            <div class="flex w-full flex-col gap-8">
              <p class="text-muted-foreground text-xs">
                Save your password &mdash; it can&rsquo;t be reset or recovered.
              </p>
              <Button
                class="w-full"
                disabled={!passwordValid || busy}
                onclick={confirmWithPassword}
              >
                {#if busy}
                  <LoaderCircle class="animate-spin" />
                {/if}
                Confirm
              </Button>
            </div>
          {/if}
        </div>
      </div>
    </main>
  {/if}
</div>
