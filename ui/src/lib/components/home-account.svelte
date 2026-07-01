<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import type { Component } from 'svelte'

  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import Copy from '@lucide/svelte/icons/copy'
  import Download from '@lucide/svelte/icons/download'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import FileDown from '@lucide/svelte/icons/file-down'
  import Fingerprint from '@lucide/svelte/icons/fingerprint'
  import Info from '@lucide/svelte/icons/info'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Lock from '@lucide/svelte/icons/lock'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Wallet from '@lucide/svelte/icons/wallet'

  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'

  import PhraseGrid from '$lib/components/phrase-grid.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import Toast from '$lib/components/toast.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Tabs } from '$lib/components/ui/tabs'
  import { backupFilename, createBackup } from '$lib/crypto/backup'
  import {
    PASSWORD_KDF_ITERATIONS,
    deriveKeyFromPassword,
    encryptSeed,
    randomSalt,
  } from '$lib/crypto/encryption'
  import { deriveWalletKey, requestWalletKeySource } from '$lib/crypto/eth-wallet'
  import { bytesToHex, prefix0x } from '$lib/crypto/hex'
  import { phraseFromEntropy, privateKeyFromEntropy } from '$lib/crypto/mnemonic'
  import { createPasskeyKey } from '$lib/crypto/passkey'
  import { unlockAccount } from '$lib/crypto/unlock'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import type { AccessMethod, Account } from '$lib/types'
  import { copyToClipboard, notImplemented, truncateAddress } from '$lib/utils'

  const TOAST_DURATION_MS = 4000
  const MIN_PASSWORD_LENGTH = 8
  const MASKED_KEY = '•'.repeat(66)
  const METHOD_TABS = [
    { value: 'passkey', label: 'Passkey' },
    { value: 'eth-wallet', label: 'ETH wallet' },
    { value: 'password', label: 'Password' },
  ]

  interface Props {
    account: Account
  }

  let { account }: Props = $props()

  type SectionId = 'identity' | 'access' | 'keys' | 'phrase' | 'backup'
  /** What the unlock confirmation is for; completes once the seed decrypts. */
  type UnlockTarget = 'private-key' | 'phrase' | 'export' | 'change-method' | 'delete'
  type DialogState =
    | { kind: 'unlock'; target: UnlockTarget; pending: boolean }
    | { kind: 'set-method'; pending: boolean }
    | { kind: 'delete' }

  let name = $derived(account.name)
  let expanded = $state<Record<SectionId, boolean>>({
    identity: false,
    access: false,
    keys: false,
    phrase: false,
    backup: false,
  })
  let bannerInfoShown = $state(false)
  let keysDetailOpen = $state(false)
  let entropy = $state<Uint8Array | undefined>(undefined)
  let privateKeyRevealed = $state(false)
  let phraseRevealed = $state(false)

  let dialog = $state<DialogState | undefined>(undefined)
  let dialogError = $state<string | undefined>(undefined)
  let busy = $state(false)
  /** Bumped on cancel/retry — a stale ceremony resolution must not complete. */
  let attempt = 0
  let abortController: AbortController | undefined

  let password = $state('')
  let newMethod = $state('passkey')
  let newPassword = $state('')
  let verifyNewPassword = $state('')

  let toastMessage = $state<string | undefined>(undefined)
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  // "Local" = no usable stamps. Use `stamps` (tombstone-filtered), not the raw
  // `postageStamps` array, so a removed stamp's tombstone doesn't read as a live
  // stamp and wrongly hide the view-only banner.
  const isLocal = $derived(account.stamps.length === 0)
  const accessLabel = $derived(methodLabel(account.access.type))
  const AccessIcon: Component = $derived(
    account.access.type === 'passkey'
      ? Fingerprint
      : account.access.type === 'eth-wallet'
        ? Wallet
        : KeyRound,
  )
  const publicKeyDisplay = $derived(account.publicKey ? prefix0x(account.publicKey) : '')
  const privateKey = $derived(entropy ? privateKeyFromEntropy(entropy) : undefined)
  const phraseWords = $derived(entropy ? phraseFromEntropy(entropy).split(' ') : [])
  const newPasswordTooShort = $derived(
    newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH,
  )
  const newPasswordMismatch = $derived(
    verifyNewPassword.length > 0 && newPassword !== verifyNewPassword,
  )
  const newPasswordValid = $derived(
    newPassword.length >= MIN_PASSWORD_LENGTH && newPassword === verifyNewPassword,
  )

  function methodLabel(type: AccessMethod['type']): string {
    return type === 'passkey' ? 'Passkey' : type === 'eth-wallet' ? 'ETH wallet' : 'Password'
  }

  function toggle(section: SectionId) {
    expanded[section] = !expanded[section]
  }

  function showToast(message: string) {
    toastMessage = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastMessage = undefined), TOAST_DURATION_MS)
  }

  function onNameChange() {
    const trimmed = name.trim()
    if (trimmed.length > 0 && trimmed !== account.name) {
      account.rename(trimmed)
    }
  }

  async function copyText(text: string, what: string) {
    if (await copyToClipboard(text)) {
      showToast(`${what} copied to clipboard`)
    } else {
      showToast('Could not copy to clipboard')
    }
  }

  function openUnlock(target: UnlockTarget) {
    dialogError = undefined
    password = ''
    if (entropy) {
      complete(target)
      return
    }
    dialog = { kind: 'unlock', target, pending: false }
  }

  function closeDialog() {
    // Invalidate any in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not complete.
    attempt++
    abortController?.abort()
    dialog = undefined
    dialogError = undefined
    busy = false
    password = ''
    newPassword = ''
    verifyNewPassword = ''
  }

  async function confirmUnlock() {
    if (busy || dialog?.kind !== 'unlock') {
      return
    }
    const target = dialog.target
    const myAttempt = ++attempt
    dialogError = undefined
    busy = true
    if (account.access.type !== 'password') {
      dialog = { kind: 'unlock', target, pending: true }
    }
    try {
      const unlocked = await unlockAccount(
        account,
        account.access.type === 'password' ? password : undefined,
      )
      if (myAttempt !== attempt) {
        return
      }
      entropy = unlocked
      password = ''
      dialog = undefined
      complete(target)
    } catch (caught) {
      if (myAttempt === attempt) {
        dialogError = caught instanceof Error ? caught.message : 'Unlock failed.'
        dialog = { kind: 'unlock', target, pending: false }
      }
    } finally {
      if (myAttempt === attempt) {
        busy = false
      }
    }
  }

  function complete(target: UnlockTarget) {
    if (target === 'private-key') {
      privateKeyRevealed = true
    } else if (target === 'phrase') {
      phraseRevealed = true
    } else if (target === 'export') {
      void exportBackupFile()
    } else if (target === 'delete') {
      deleteAccount()
    } else {
      newMethod = 'passkey'
      newPassword = ''
      verifyNewPassword = ''
      dialog = { kind: 'set-method', pending: false }
    }
  }

  async function confirmNewMethod() {
    if (busy || dialog?.kind !== 'set-method' || !entropy) {
      return
    }
    const myAttempt = ++attempt
    dialogError = undefined
    busy = true
    if (newMethod !== 'password') {
      dialog = { kind: 'set-method', pending: true }
    }
    try {
      let access: AccessMethod
      let key: CryptoKey
      if (newMethod === 'passkey') {
        abortController = new AbortController()
        const passkey = await createPasskeyKey(account.name, abortController.signal)
        access = { type: 'passkey', credentialId: passkey.credentialId }
        key = passkey.key
      } else if (newMethod === 'eth-wallet') {
        const source = await requestWalletKeySource()
        const salt = randomSalt()
        key = await deriveWalletKey(source, salt)
        access = {
          type: 'eth-wallet',
          encryptionSalt: bytesToHex(salt),
        }
      } else {
        const salt = randomSalt()
        key = await deriveKeyFromPassword(newPassword, salt)
        access = {
          type: 'password',
          kdfSalt: bytesToHex(salt),
          kdfIterations: PASSWORD_KDF_ITERATIONS,
        }
      }
      if (myAttempt !== attempt) {
        return
      }
      account.setAccess(access, await encryptSeed(entropy, key))
      dialog = undefined
      newPassword = ''
      verifyNewPassword = ''
      showToast('Unlock method updated')
    } catch (caught) {
      if (myAttempt === attempt) {
        dialogError = caught instanceof Error ? caught.message : 'Could not set the new method.'
        dialog = { kind: 'set-method', pending: false }
      }
    } finally {
      if (myAttempt === attempt) {
        busy = false
        abortController = undefined
      }
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

  function lockAccount() {
    entropy = undefined
    sessionStore.clearCurrentAccount()
    goto(resolve(routes.ROOT))
  }

  function deleteAccount() {
    // The account's connected apps and stamps are nested in the record, so they
    // are removed with it; the resulting storage event de-authenticates any
    // connected dApp proxy iframes.
    accountsStore.remove(account.id)
    const next = accountsStore.accounts[0]
    if (next) {
      sessionStore.setCurrentAccount(next.id)
    } else {
      sessionStore.clearCurrentAccount()
      goto(resolve(routes.ROOT))
    }
    dialog = undefined
  }
</script>

{#snippet sectionHeader(id: SectionId, title: string, description: string)}
  <button
    type="button"
    class="flex w-full cursor-pointer flex-col items-start text-left"
    aria-expanded={expanded[id]}
    onclick={() => toggle(id)}
  >
    <span class="flex items-center gap-1.5 text-sm font-bold">
      {#if expanded[id]}
        <ChevronDown class="size-3.5" />
      {:else}
        <ChevronRight class="size-3.5" />
      {/if}
      {title}
    </span>
    <span class="pl-5 text-sm">{description}</span>
  </button>
{/snippet}

{#snippet keyBlock(label: string, description: string)}
  <div class="flex flex-col">
    <p class="text-sm font-medium">{label}</p>
    <p class="text-muted-foreground text-xs">{description}</p>
  </div>
{/snippet}

{#snippet pendingBody(label: string, caption: string)}
  <div class="flex flex-col items-center gap-2 py-2">
    <LoaderCircle class="size-5 animate-spin" />
    <div class="flex flex-col items-center text-center">
      <p class="text-sm font-bold">{label}</p>
      <p class="text-sm">{caption}</p>
    </div>
  </div>
  <Button variant="outline" class="w-full" onclick={closeDialog}>Cancel</Button>
{/snippet}

<div class="flex w-full flex-col gap-6">
  {#if isLocal}
    <!-- Local account banner: no stamps yet, so the account is view-only. -->
    <div class="bg-muted flex w-full flex-col gap-2 rounded-lg px-4 py-2">
      <div class="flex w-full items-center gap-2">
        <Info class="size-4 shrink-0" />
        <p class="flex-1 text-sm">Local account (view-only)</p>
        <!-- Stamp purchase flow is still TBD in the design. -->
        <Button size="xs" onclick={notImplemented}>Upgrade</Button>
        <Button size="xs" variant="ghost" onclick={() => (bannerInfoShown = !bannerInfoShown)}>
          Info
        </Button>
      </div>
      {#if bannerInfoShown}
        <p class="text-muted-foreground pl-6 text-sm">
          This is a local account, view-only and not synced. Upgrade by adding a postage stamp to
          upload data and use your Swarm ID across all your devices.
        </p>
      {/if}
    </div>
  {/if}

  <!-- Identity -->
  <div class="flex w-full flex-col gap-3">
    {@render sectionHeader('identity', 'Identity', 'Name and picture displayed in connected apps.')}
    {#if expanded.identity}
      <div class="flex w-full items-center gap-2 pl-5">
        <Input bind:value={name} onchange={onNameChange} />
        <Polycon value={account.id.toHex()} size={32} class="shrink-0 overflow-hidden rounded-lg" />
      </div>
    {/if}
  </div>

  <!-- Access security -->
  <div class="flex w-full flex-col gap-3">
    {@render sectionHeader(
      'access',
      'Access security',
      'The method used to unlock your account on this device.',
    )}
    {#if expanded.access}
      <div class="pl-5">
        <div class="border-border flex h-12 w-full items-center gap-2 rounded-lg border px-4">
          <AccessIcon class="size-4 shrink-0" />
          <p class="flex-1 text-sm">{accessLabel}</p>
          <Button
            variant="ghost"
            size="sm"
            class="-mr-2"
            onclick={() => openUnlock('change-method')}
          >
            <RefreshCw />
            Change
          </Button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Address & keys -->
  <div class="flex w-full flex-col gap-3">
    {@render sectionHeader(
      'keys',
      'Address & keys',
      "Your account's address, public key, and private key.",
    )}
    {#if expanded.keys}
      <div class="pl-5">
        <div class="border-border flex w-full flex-col rounded-lg border">
          <div class="flex h-12 w-full items-center gap-2 px-4">
            <p class="flex-1 truncate text-sm">{truncateAddress(account.id.toChecksum())}</p>
            <Button
              variant="ghost"
              size="sm"
              onclick={() => copyText(account.id.toChecksum(), 'Address')}
            >
              <Copy />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="-mr-2 size-7"
              aria-label={keysDetailOpen ? 'Hide keys' : 'Show keys'}
              onclick={() => (keysDetailOpen = !keysDetailOpen)}
            >
              <ChevronsUpDown />
            </Button>
          </div>

          {#if keysDetailOpen}
            <div class="bg-muted mx-1 mb-1 flex flex-col gap-4 rounded-md p-4">
              <div class="flex flex-col gap-1">
                {@render keyBlock('Address', 'The unique identifier for your Swarm ID.')}
                <div class="flex items-center gap-2">
                  <p class="min-w-0 flex-1 text-sm break-all">{account.id.toChecksum()}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-7 shrink-0"
                    aria-label="Copy address"
                    onclick={() => copyText(account.id.toChecksum(), 'Address')}
                  >
                    <Copy />
                  </Button>
                </div>
              </div>

              <div class="flex flex-col gap-1">
                {@render keyBlock(
                  'Public key',
                  'Can be used for establishing secure, private communication.',
                )}
                <div class="flex items-center gap-2">
                  <p class="min-w-0 flex-1 text-sm break-all">{publicKeyDisplay}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-7 shrink-0"
                    aria-label="Copy public key"
                    onclick={() => copyText(publicKeyDisplay, 'Public key')}
                  >
                    <Copy />
                  </Button>
                </div>
              </div>

              <div class="flex flex-col gap-1">
                {@render keyBlock(
                  'Private key',
                  'Grants full control over your account. Never share it.',
                )}
                <div class="flex items-center gap-2">
                  {#if privateKeyRevealed && privateKey}
                    <p class="min-w-0 flex-1 text-sm break-all">{privateKey}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7 shrink-0"
                      aria-label="Copy private key"
                      onclick={() => copyText(privateKey, 'Private key')}
                    >
                      <Copy />
                    </Button>
                  {:else}
                    <p class="min-w-0 flex-1 text-sm break-all select-none">{MASKED_KEY}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7 shrink-0"
                      aria-label="Reveal private key"
                      onclick={() => openUnlock('private-key')}
                    >
                      <Eye />
                    </Button>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- Secret recovery phrase -->
  <div class="flex w-full flex-col gap-3">
    {@render sectionHeader(
      'phrase',
      'Secret recovery phrase',
      'Used to sign in on another device or restore access if you lose it.',
    )}
    {#if expanded.phrase}
      <div class="flex w-full flex-col gap-4 pl-5">
        {#if phraseRevealed && phraseWords.length > 0}
          <PhraseGrid words={phraseWords} />
          <div class="flex w-full items-center gap-4">
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy phrase"
                onclick={() => entropy && copyText(phraseFromEntropy(entropy), 'Seed phrase')}
              >
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
          <Button variant="outline" class="w-full" onclick={() => (phraseRevealed = false)}>
            <EyeOff />
            Hide secret recovery phrase
          </Button>
        {:else}
          <div
            class="border-border flex h-38 w-full flex-col items-center justify-center gap-2 rounded-lg border"
          >
            <Button variant="ghost" onclick={() => openUnlock('phrase')}>
              <Eye />
              Reveal
            </Button>
            <p class="text-muted-foreground text-xs">Make sure no one is watching your screen.</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Backup -->
  <div class="flex w-full flex-col gap-3">
    {@render sectionHeader('backup', 'Backup', 'Exports an encrypted backup of your account.')}
    {#if expanded.backup}
      <div class="pl-5">
        <Button variant="outline" onclick={() => openUnlock('export')}>
          <FileDown />
          Export .swarmid file
        </Button>
      </div>
    {/if}
  </div>

  <div class="bg-border h-px w-full"></div>

  <div class="flex w-full items-center justify-between">
    <Button variant="outline" onclick={lockAccount}>
      <Lock />
      Lock account
    </Button>
    <Button variant="destructive" onclick={() => (dialog = { kind: 'delete' })}>
      <Trash2 />
      Delete account
    </Button>
  </div>
</div>

{#if dialog?.kind === 'unlock'}
  {#if dialog.pending}
    <Dialog onclose={closeDialog} dismissable={false}>
      {@render pendingBody(
        account.access.type === 'eth-wallet' ? 'Confirm with wallet' : 'Confirm with passkey',
        account.access.type === 'eth-wallet'
          ? 'Approve the request in your Ethereum wallet.'
          : 'Follow the prompts on your device.',
      )}
    </Dialog>
  {:else}
    <Dialog
      onclose={closeDialog}
      title={dialog.target === 'private-key'
        ? 'Reveal private key'
        : dialog.target === 'phrase'
          ? 'Reveal secret recovery phrase'
          : dialog.target === 'export'
            ? 'Export backup'
            : dialog.target === 'delete'
              ? 'Delete account'
              : 'Change unlock method'}
    >
      <p class="text-sm">
        {#if dialog.target === 'change-method'}
          This changes how you unlock your account on this device only. To continue, confirm with
          your current {accessLabel.toLowerCase()}.
        {:else if dialog.target === 'export'}
          Unlock your account to export an encrypted backup file.
        {:else if dialog.target === 'delete'}
          Unlock your account to confirm the deletion.
        {:else}
          Make sure no one is watching your screen.
        {/if}
      </p>

      {#if account.access.type === 'password'}
        <Input
          type="password"
          bind:value={password}
          placeholder="Account password"
          autocomplete="current-password"
          onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirmUnlock()}
        />
      {/if}

      {#if dialogError}
        <p class="text-destructive text-xs">{dialogError}</p>
      {/if}

      <Button
        class="w-full"
        disabled={busy || (account.access.type === 'password' && password.length === 0)}
        onclick={confirmUnlock}
      >
        {#if busy}
          <LoaderCircle class="animate-spin" />
        {/if}
        {account.access.type === 'passkey'
          ? 'Confirm with passkey'
          : account.access.type === 'eth-wallet'
            ? 'Confirm with wallet'
            : 'Confirm'}
      </Button>
    </Dialog>
  {/if}
{:else if dialog?.kind === 'set-method'}
  {#if dialog.pending}
    <Dialog onclose={closeDialog} dismissable={false}>
      {@render pendingBody(
        newMethod === 'eth-wallet' ? 'Confirm with new wallet' : 'Confirm with new passkey',
        newMethod === 'eth-wallet'
          ? 'Approve the request in your Ethereum wallet.'
          : 'Follow the prompts on your device.',
      )}
    </Dialog>
  {:else}
    <Dialog onclose={closeDialog} title="Set new unlock method">
      <Tabs tabs={METHOD_TABS} bind:value={newMethod} />

      {#if newMethod === 'passkey'}
        <p class="text-sm">
          Unlock with your device&rsquo;s built-in authentication &mdash; fingerprint, face, or PIN.
        </p>
      {:else if newMethod === 'eth-wallet'}
        <p class="text-sm">Unlock by signing a message with your Ethereum wallet.</p>
      {:else}
        <div class="flex w-full flex-col gap-4">
          <div class="flex w-full flex-col gap-2">
            <label for="change-new-password" class="text-sm font-medium">
              Create new password
            </label>
            <Input
              id="change-new-password"
              type="password"
              bind:value={newPassword}
              autocomplete="new-password"
              aria-invalid={newPasswordTooShort}
            />
            <p
              class={newPasswordTooShort
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'}
            >
              Must be at least {MIN_PASSWORD_LENGTH} characters
            </p>
          </div>
          <div class="flex w-full flex-col gap-2">
            <label for="change-verify-password" class="text-sm font-medium">Verify password</label>
            <Input
              id="change-verify-password"
              type="password"
              bind:value={verifyNewPassword}
              autocomplete="new-password"
              aria-invalid={newPasswordMismatch}
            />
            {#if newPasswordMismatch}
              <p class="text-destructive text-xs">Passwords do not match</p>
            {/if}
          </div>
        </div>
      {/if}

      {#if dialogError}
        <p class="text-destructive text-xs">{dialogError}</p>
      {/if}

      <Button
        class="w-full"
        disabled={busy || (newMethod === 'password' && !newPasswordValid)}
        onclick={confirmNewMethod}
      >
        {#if busy}
          <LoaderCircle class="animate-spin" />
        {/if}
        {newMethod === 'passkey'
          ? 'Confirm with new passkey'
          : newMethod === 'eth-wallet'
            ? 'Confirm with new wallet'
            : 'Confirm'}
      </Button>
    </Dialog>
  {/if}
{:else if dialog?.kind === 'delete'}
  <Dialog onclose={closeDialog} title="Delete account">
    <p class="text-sm">
      This removes the account and its data from this device. You can get it back later with a
      backup file or its secret recovery phrase.{#if !entropy}
        You'll be asked to unlock your account to confirm.{/if}
    </p>
    <div class="flex w-full flex-col gap-2">
      <Button variant="destructive" class="w-full" onclick={() => openUnlock('delete')}>
        <Trash2 />
        Delete account
      </Button>
      <Button variant="outline" class="w-full" onclick={closeDialog}>Cancel</Button>
    </div>
  </Dialog>
{/if}

<Toast message={toastMessage} />
