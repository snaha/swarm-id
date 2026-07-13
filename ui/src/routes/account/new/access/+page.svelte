<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import { EthAddress } from '@ethersphere/bee-js'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import {
    type AccessMethod,
    type Account as AccountRecord,
    PARTITION_COUNT,
    deriveAccountDerivationKey,
  } from '@snaha/swarm-id'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import AppHeader from '$lib/components/app-header.svelte'
  import NewPasswordFields, { isNewPasswordValid } from '$lib/components/new-password-fields.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Tabs } from '$lib/components/ui/tabs'
  import { completeConnect } from '$lib/connect-handshake'
  import { createAccess } from '$lib/crypto/access-setup'
  import { encryptSeed } from '$lib/crypto/encryption'
  import { strip0x } from '$lib/crypto/hex'
  import { walletFromPhrase } from '$lib/crypto/mnemonic'
  import { triggerSync } from '$lib/dev/sync-hooks'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectStore } from '$lib/stores/connect.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'

  const TABS = [
    { value: 'passkey', label: 'Passkey' },
    { value: 'eth-wallet', label: 'ETH wallet' },
    { value: 'password', label: 'Password' },
  ]

  let method = $state('passkey')
  let pending = $state(false)
  let busy = $state(false)
  let error = $state<string | undefined>(undefined)

  let password = $state('')
  let verifyPassword = $state('')

  let abortController: AbortController | undefined
  /** Bumped on cancel/retry — a stale ceremony resolution must not finalize. */
  let attempt = 0

  const passwordValid = $derived(isNewPasswordValid(password, verifyPassword))

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

  onDestroy(() => {
    // Leaving the page (back navigation) is an implicit cancel: an in-flight
    // ceremony or finalize must not later create the account and yank the
    // user to the done page.
    attempt++
    abortController?.abort()
  })

  async function finalize(access: AccessMethod, key: CryptoKey, myAttempt: number) {
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
    const masterKey = strip0x(wallet.privateKey)
    const [derivationKey, encryptedSeed] = await Promise.all([
      deriveAccountDerivationKey(masterKey),
      encryptSeed(wallet.entropy, key),
    ])
    // The derivation gave Cancel a window — a superseded attempt must not
    // create the account or navigate (#423).
    if (myAttempt !== attempt) {
      return
    }
    const account: AccountRecord = {
      id: new EthAddress(wallet.address),
      name: draft.name,
      publicKey: strip0x(wallet.publicKey),
      createdAt: carried?.createdAt ?? Date.now(),
      derivationKey,
      access,
      encryptedSeed,
      settings: carried?.settings,
      defaultPostageStampBatchID: carried?.defaultPostageStampBatchID,
      // Preserve the carried record's per-field LWW clocks so re-importing a
      // phrase doesn't reset convergence metadata and make local scalar edits
      // look stale to sync/merge.
      accountNameAt: carried?.accountNameAt,
      defaultStampAt: carried?.defaultStampAt,
      settingsAt: carried?.settingsAt,
      lastModified: carried?.lastModified,
      devices: carried?.devices ?? [],
      connectedApps: carried?.connectedApps ?? [],
      postageStamps: carried?.postageStamps ?? [],
      partitionCount: carried?.partitionCount ?? PARTITION_COUNT,
    }
    // `add` returns the live reactive account; the handshake mutates it.
    const liveAccount = accountsStore.add(account)
    sessionStore.setCurrentAccount(liveAccount.id)
    // `add` persists but doesn't fire the sync hook (only field mutations do),
    // so publish once here to register this device in the Swarm roster. No-ops
    // harmlessly until the account has a stamp to sign the upload.
    triggerSync(liveAccount.id.toHex())
    const flow = draft.flow

    // Came from a dApp connect popup — finish the handshake and hand back.
    // The draft is cleared only once the handshake succeeded, so a failure
    // leaves the Confirm buttons functional for a retry.
    const request = connectStore.request
    if (request) {
      await completeConnect(liveAccount, wallet.entropy, request)
      // Cancelled while the handshake was in flight: the account exists and
      // the dApp got its secret, but stay put — the intact draft lets the
      // user confirm again rather than being yanked to the done page.
      if (myAttempt !== attempt) {
        return
      }
      sessionStore.setCompletedFlow(flow)
      sessionStore.clearDraft()
      goto(resolve(routes.CONNECT_DONE))
      return
    }

    sessionStore.setCompletedFlow(flow)
    sessionStore.clearDraft()
    goto(resolve(flow === 'create' ? routes.ACCOUNT_NEW_DONE : routes.ACCOUNT_READY))
  }

  async function confirm() {
    const draft = sessionStore.draft
    if (busy || !draft) {
      return
    }
    const myAttempt = ++attempt
    error = undefined
    busy = true
    if (method !== 'password') {
      pending = true
    }
    try {
      abortController = method === 'passkey' ? new AbortController() : undefined
      const { access, key } = await createAccess(method, {
        accountName: draft.name,
        password,
        signal: abortController?.signal,
      })
      if (myAttempt !== attempt) {
        return
      }
      await finalize(access, key, myAttempt)
    } catch (caught) {
      if (myAttempt === attempt) {
        error =
          caught instanceof Error
            ? caught.message
            : method === 'passkey'
              ? 'Passkey creation failed.'
              : method === 'eth-wallet'
                ? 'Wallet signing failed.'
                : 'Encryption failed.'
      }
    } finally {
      if (myAttempt === attempt) {
        pending = false
        busy = false
        abortController = undefined
      }
    }
  }

  function cancelPending() {
    // Invalidate the in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not finalize.
    attempt++
    abortController?.abort()
    pending = false
    busy = false
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
              {method === 'passkey' ? 'Confirm with passkey' : 'Confirm with wallet'}
            </p>
            <p class="text-sm">
              {method === 'passkey'
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
            <NewPasswordFields bind:password bind:verify={verifyPassword} />
          {/if}

          {#if error}
            <p class="text-destructive w-full text-xs">{error}</p>
          {/if}

          {#if method === 'passkey'}
            <Button class="w-full" onclick={confirm}>Confirm with passkey</Button>
          {:else if method === 'eth-wallet'}
            <Button class="w-full" onclick={confirm}>Confirm with wallet</Button>
          {:else}
            <div class="flex w-full flex-col gap-8">
              <p class="text-muted-foreground text-xs">
                Save your password &mdash; it can&rsquo;t be reset or recovered.
              </p>
              <Button class="w-full" disabled={!passwordValid || busy} onclick={confirm}>
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
