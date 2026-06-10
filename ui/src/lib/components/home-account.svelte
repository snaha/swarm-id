<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import Eye from '@lucide/svelte/icons/eye'
  import Fingerprint from '@lucide/svelte/icons/fingerprint'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Wallet from '@lucide/svelte/icons/wallet'

  import PhraseGrid from '$lib/components/phrase-grid.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import Toast from '$lib/components/toast.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { backupFilename, createBackup } from '$lib/crypto/backup'
  import { phraseFromEntropy, privateKeyFromEntropy } from '$lib/crypto/mnemonic'
  import { unlockAccount } from '$lib/crypto/unlock'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import type { Account } from '$lib/types'

  const TOAST_DURATION_MS = 4000
  const ADDRESS_PREFIX_LENGTH = 6
  const ADDRESS_SUFFIX_LENGTH = 4
  const MASKED_KEY = '•'.repeat(66)

  interface Props {
    account: Account
  }

  let { account }: Props = $props()

  type UnlockTarget = 'private-key' | 'phrase' | 'export'

  let name = $derived(account.name)
  let addressExpanded = $state(false)
  let entropy = $state<Uint8Array | undefined>(undefined)
  let privateKeyRevealed = $state(false)
  let phraseRevealed = $state(false)
  let passwordPromptFor = $state<UnlockTarget | undefined>(undefined)
  let password = $state('')
  let unlockBusyFor = $state<UnlockTarget | undefined>(undefined)
  let unlockError = $state<string | undefined>(undefined)
  let toastMessage = $state<string | undefined>(undefined)
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  const truncatedAddress = $derived(
    `${account.id.slice(0, ADDRESS_PREFIX_LENGTH)}...${account.id.slice(-ADDRESS_SUFFIX_LENGTH)}`,
  )
  const accessLabel = $derived(
    account.access.type === 'passkey'
      ? 'Passkey'
      : account.access.type === 'eth-wallet'
        ? 'ETH wallet'
        : 'Password',
  )
  const AccessIcon = $derived(
    account.access.type === 'passkey'
      ? Fingerprint
      : account.access.type === 'eth-wallet'
        ? Wallet
        : KeyRound,
  )
  const privateKey = $derived(entropy ? privateKeyFromEntropy(entropy) : undefined)
  const phraseWords = $derived(entropy ? phraseFromEntropy(entropy).split(' ') : [])

  function showToast(message: string) {
    toastMessage = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastMessage = undefined), TOAST_DURATION_MS)
  }

  function onNameChange() {
    const trimmed = name.trim()
    if (trimmed.length > 0 && trimmed !== account.name) {
      accountsStore.rename(account.id, trimmed)
    }
  }

  async function copyText(text: string, what: string) {
    await navigator.clipboard.writeText(text)
    showToast(`${what} copied to clipboard`)
  }

  /** Make sure the seed is decrypted, then run the target's reveal/export. */
  async function requestUnlock(target: UnlockTarget) {
    unlockError = undefined
    if (entropy) {
      complete(target)
      return
    }
    if (account.access.type === 'password' && !passwordPromptFor) {
      passwordPromptFor = target
      return
    }
    unlockBusyFor = target
    try {
      entropy = await unlockAccount(
        account,
        account.access.type === 'password' ? password : undefined,
      )
      passwordPromptFor = undefined
      password = ''
      complete(target)
    } catch (caught) {
      unlockError = caught instanceof Error ? caught.message : 'Unlock failed.'
    } finally {
      unlockBusyFor = undefined
    }
  }

  function complete(target: UnlockTarget) {
    if (target === 'private-key') {
      privateKeyRevealed = true
    } else if (target === 'phrase') {
      phraseRevealed = true
    } else {
      void exportBackupFile()
    }
  }

  async function exportBackupFile() {
    if (!entropy) {
      return
    }
    const contents = await createBackup(account, entropy)
    const blob = new Blob([contents], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = backupFilename(new Date())
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function downloadPhrase() {
    if (!entropy) {
      return
    }
    const blob = new Blob([phraseFromEntropy(entropy)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'swarm-id-recovery-phrase.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }
</script>

{#snippet passwordPrompt(target: UnlockTarget)}
  {#if passwordPromptFor === target}
    <div class="flex w-full items-center gap-2">
      <Input
        type="password"
        bind:value={password}
        placeholder="Account password"
        autocomplete="current-password"
        onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && requestUnlock(target)}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={password.length === 0 || unlockBusyFor === target}
        onclick={() => requestUnlock(target)}
      >
        {#if unlockBusyFor === target}
          <LoaderCircle class="animate-spin" />
        {/if}
        Unlock
      </Button>
    </div>
    {#if unlockError}
      <p class="text-destructive text-xs">{unlockError}</p>
    {/if}
  {/if}
{/snippet}

<div class="flex w-full flex-col">
  <!-- Account name -->
  <div class="border-border flex w-full items-center justify-between gap-4 border-b py-4">
    <p class="text-sm font-medium">Account name</p>
    <div class="flex items-center gap-2">
      <Input bind:value={name} class="w-44" onchange={onNameChange} />
      <Polycon value={account.id} size={32} class="shrink-0 overflow-hidden rounded-lg" />
    </div>
  </div>

  <!-- Access security -->
  <div class="border-border flex w-full items-center justify-between gap-4 border-b py-4">
    <div class="flex max-w-52 flex-col">
      <p class="text-sm font-medium">Access security</p>
      <p class="text-muted-foreground text-xs">
        Choose how to unlock your Swarm ID account on this device.
      </p>
    </div>
    <div class="flex items-center gap-4">
      <span class="flex items-center gap-1.5 text-sm font-medium">
        <AccessIcon class="size-4" />
        {accessLabel}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled
        title="Changing the access method is coming soon"
      >
        Change
      </Button>
    </div>
  </div>

  <!-- Account address -->
  <div class="border-border flex w-full flex-col gap-3 border-b py-4">
    <div class="flex flex-col">
      <p class="text-sm font-medium">Account address</p>
      <p class="text-muted-foreground text-xs">
        A unique identifier for your Swarm ID, used by others to find or interact with you.
      </p>
    </div>
    <div class="flex w-full items-center justify-between gap-2">
      <p class="min-w-0 truncate text-sm">{addressExpanded ? account.id : truncatedAddress}</p>
      <div class="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => copyText(account.id, 'Address')}>
          Copy
        </Button>
        <Button
          variant="outline"
          size="icon"
          class="size-7 rounded-md"
          aria-label={addressExpanded ? 'Hide keys' : 'Show keys'}
          onclick={() => (addressExpanded = !addressExpanded)}
        >
          {#if addressExpanded}
            <ChevronUp />
          {:else}
            <ChevronDown />
          {/if}
        </Button>
      </div>
    </div>

    {#if addressExpanded}
      <div class="flex w-full flex-col gap-4 pl-6">
        <div class="flex w-full flex-col gap-1">
          <p class="text-sm font-medium">Public key</p>
          <p class="text-muted-foreground text-xs">
            Your public key is the cryptographic identity behind your address. Safe to share.
          </p>
          <div class="flex w-full items-end justify-between gap-2">
            <p class="min-w-0 text-sm break-all">{account.publicKey}</p>
            <Button
              variant="outline"
              size="sm"
              class="shrink-0"
              onclick={() => copyText(account.publicKey, 'Public key')}
            >
              Copy
            </Button>
          </div>
        </div>

        <div class="flex w-full flex-col gap-1">
          <p class="text-sm font-medium">Private key</p>
          <p class="text-muted-foreground text-xs">
            Your private key grants full control over your account. Never share it.
          </p>
          <div class="flex w-full items-end justify-between gap-2">
            {#if privateKeyRevealed && privateKey}
              <p class="min-w-0 text-sm break-all">{privateKey}</p>
              <Button
                variant="outline"
                size="sm"
                class="shrink-0"
                onclick={() => copyText(privateKey, 'Private key')}
              >
                Copy
              </Button>
            {:else}
              <p class="min-w-0 truncate text-sm select-none">{MASKED_KEY}</p>
              <Button
                variant="outline"
                size="sm"
                class="shrink-0"
                disabled={unlockBusyFor === 'private-key'}
                onclick={() => requestUnlock('private-key')}
              >
                {#if unlockBusyFor === 'private-key'}
                  <LoaderCircle class="animate-spin" />
                {:else}
                  <Eye />
                {/if}
                Reveal
              </Button>
            {/if}
          </div>
          {@render passwordPrompt('private-key')}
          {#if unlockError && passwordPromptFor === undefined && account.access.type !== 'password'}
            <p class="text-destructive text-xs">{unlockError}</p>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- Secret recovery phrase -->
  <div class="border-border flex w-full flex-col gap-3 border-b py-4">
    <div class="flex flex-col">
      <p class="text-sm font-medium">Secret recovery phrase</p>
      <p class="text-muted-foreground text-xs">
        Needed to sign in to your account on another device or restore it here if you lose access.
      </p>
    </div>

    {#if phraseRevealed && phraseWords.length > 0}
      <PhraseGrid words={phraseWords} />
    {:else}
      <div
        class="border-input flex h-38 w-full flex-col items-center justify-center gap-2 rounded-lg border"
      >
        <Button
          variant="outline"
          size="sm"
          disabled={unlockBusyFor === 'phrase'}
          onclick={() => requestUnlock('phrase')}
        >
          {#if unlockBusyFor === 'phrase'}
            <LoaderCircle class="animate-spin" />
          {:else}
            <Eye />
          {/if}
          Reveal
        </Button>
        <p class="text-muted-foreground text-xs">Make sure no one is watching your screen.</p>
      </div>
    {/if}
    {@render passwordPrompt('phrase')}

    <div class="flex w-full items-center justify-between gap-4">
      <p class="text-xs">
        <span class="font-bold">Save in a safe place.</span> If someone has it, they can access your account.
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!phraseRevealed}
          onclick={() => entropy && copyText(phraseFromEntropy(entropy), 'Seed phrase')}
        >
          Copy
        </Button>
        <Button variant="outline" size="sm" disabled={!phraseRevealed} onclick={downloadPhrase}>
          Download .txt
        </Button>
      </div>
    </div>
  </div>

  <!-- Backup -->
  <div class="flex w-full items-center justify-between gap-4 py-4">
    <div class="flex max-w-60 flex-col">
      <p class="text-sm font-medium">Backup</p>
      <p class="text-muted-foreground text-xs">
        Save your account data to a local encrypted file so you can restore it later.
      </p>
    </div>
    <Button
      variant="outline"
      size="sm"
      class="shrink-0"
      disabled={unlockBusyFor === 'export'}
      onclick={() => requestUnlock('export')}
    >
      {#if unlockBusyFor === 'export'}
        <LoaderCircle class="animate-spin" />
      {/if}
      Export .swarmid file
    </Button>
  </div>
  {@render passwordPrompt('export')}
</div>

<Toast message={toastMessage} />
