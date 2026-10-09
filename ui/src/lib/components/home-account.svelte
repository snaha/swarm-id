<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { type Component, tick } from 'svelte'

  import { PrivateKey, PublicKey } from '@ethersphere/bee-js'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Copy from '@lucide/svelte/icons/copy'
  import Download from '@lucide/svelte/icons/download'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import FileDown from '@lucide/svelte/icons/file-down'
  import Fingerprint from '@lucide/svelte/icons/fingerprint'
  import Info from '@lucide/svelte/icons/info'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Wallet from '@lucide/svelte/icons/wallet'
  import { uint8ArrayToHex } from '@snaha/swarm-id'
  import {
    type AccessMethod,
    derivePostageSignerKeySync,
    deriveSharingKey,
    encryptSeed,
  } from '@snaha/swarm-id/internal'

  import { createAttemptTracker } from '$lib/attempt'
  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import DeleteAccountDialog from '$lib/components/delete-account-dialog.svelte'
  import DriveAddDialog from '$lib/components/drive-add-dialog.svelte'
  import KeyCard from '$lib/components/key-card.svelte'
  import NewPasswordFields, { isNewPasswordValid } from '$lib/components/new-password-fields.svelte'
  import PhraseGrid from '$lib/components/phrase-grid.svelte'
  import SignOutDialog from '$lib/components/sign-out-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Tabs } from '$lib/components/ui/tabs'
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import { createAccess } from '$lib/crypto/access-setup'
  import { backupFilename, createBackup } from '$lib/crypto/backup'
  import { prefix0x } from '$lib/crypto/hex'
  import { phraseFromEntropy, privateKeyFromEntropy } from '$lib/crypto/mnemonic'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'
  import { copyToClipboard } from '$lib/utils'

  const METHOD_TABS = [
    { value: 'passkey', label: 'Passkey' },
    { value: 'eth-wallet', label: 'ETH wallet' },
    { value: 'password', label: 'Password' },
  ]

  interface Props {
    account: Account
    /** From the URL hash (`#account/<section>[/<key card>]`): what to open. */
    target?: string[]
  }

  let { account, target = [] }: Props = $props()

  const SECTION_IDS = ['identity', 'access', 'keys', 'phrase', 'backup'] as const
  type SectionId = (typeof SECTION_IDS)[number]
  function isSectionId(value: string | undefined): value is SectionId {
    return SECTION_IDS.some((id) => id === value)
  }
  /** What the unlock confirmation is for; completes once the seed decrypts. */
  type UnlockTarget = 'private-key' | 'phrase' | 'export' | 'change-method'

  let name = $derived(account.name)
  let expanded = $state<Record<SectionId, boolean>>({
    identity: false,
    access: false,
    keys: false,
    phrase: false,
    backup: false,
  })
  let bannerInfoShown = $state(false)
  let addDriveOpen = $state(false)
  let keysDetailOpen = $state(false)
  let sharingDetailOpen = $state(false)
  let signerDetailOpen = $state(false)

  // Re-runs on a new hash only: the explicit list keeps it from reading
  // `expanded`, which would re-open the section as soon as the user collapsed
  // it. The list also rejects inherited keys like `#account/constructor`.
  $effect(() => {
    const [section, card] = target
    if (!isSectionId(section)) return
    expanded[section] = true
    if (section === 'keys' && card === 'account-identity') keysDetailOpen = true
    if (section === 'keys' && card === 'data-sharing') sharingDetailOpen = true
    if (section === 'keys' && card === 'drive-management') signerDetailOpen = true
    tick().then(() => {
      const el =
        (card && document.getElementById(`account-${section}-${card}`)) ||
        document.getElementById(`account-${section}`)
      el?.scrollIntoView()
    })
  })

  let signingOut = $state(false)
  let deleting = $state(false)
  // Reveals cache only their derived display value — never the raw seed, which
  // is zeroed the moment each ceremony finishes with it (issue #412).
  let revealedPrivateKey = $state<string | undefined>(undefined)
  // No unlock for these two: they derive from `derivationKey`, which sits in
  // plaintext in storage while signed in, so a dialog would only pretend to
  // guard them. The mask is a shoulder-surfing courtesy, nothing more.
  let revealedSharingKey = $state<string | undefined>(undefined)
  let revealedSignerKey = $state<string | undefined>(undefined)
  let revealedPhrase = $state<string[] | undefined>(undefined)
  // Seed held only across the change-method two-step ceremony; zeroed after.
  let changeMethodSeed: Uint8Array | undefined

  let unlockTarget = $state<UnlockTarget | undefined>(undefined)
  let setMethodDialog = $state<'form' | 'pending' | undefined>(undefined)
  let dialogError = $state<string | undefined>(undefined)
  let busy = $state(false)
  /** Cancel/retry supersedes the in-flight ceremony — it must not complete. */
  const attempts = createAttemptTracker()
  let abortController: AbortController | undefined

  let newMethod = $state('passkey')
  let newPassword = $state('')
  let verifyNewPassword = $state('')

  const isLocal = $derived(account.isLocal)
  // The Account tab only renders for the signed-in current account, so the
  // access method is always present (`accessMethod` asserts it).
  const access = $derived(account.accessMethod)
  const accessLabel = $derived(methodLabel(access.type))
  const AccessIcon: Component = $derived(
    access.type === 'passkey' ? Fingerprint : access.type === 'eth-wallet' ? Wallet : KeyRound,
  )
  const publicKeyDisplay = $derived(account.publicKey)
  const sharingKey = $derived(deriveSharingKey(account.derivationKey))
  const sharingKeyDisplay = $derived(sharingKey.publicKey)
  const sharingAddress = $derived(new PublicKey(sharingKey.publicKey).address().toChecksum())
  const sharingPrivateKeyDisplay = $derived(prefix0x(uint8ArrayToHex(sharingKey.secret)))
  // The key every drive of the account is bought for (#848): its address is
  // the batch owner on-chain.
  const signerKey = $derived(derivePostageSignerKeySync(account.derivationKey))
  const signerAddress = $derived(new PrivateKey(signerKey).publicKey().address().toChecksum())
  const signerPrivateKeyDisplay = $derived(prefix0x(signerKey))
  const newPasswordValid = $derived(isNewPasswordValid(newPassword, verifyNewPassword))

  const unlockTitle = $derived(
    unlockTarget === 'private-key'
      ? 'Reveal private key'
      : unlockTarget === 'phrase'
        ? 'Reveal secret recovery phrase'
        : unlockTarget === 'export'
          ? 'Export backup'
          : 'Change unlock method',
  )
  const unlockDescription = $derived(
    unlockTarget === 'change-method'
      ? `This changes how you unlock your account on this device only. To continue, confirm with your current ${accessLabel.toLowerCase()}.`
      : unlockTarget === 'export'
        ? 'Unlock your account to export an encrypted backup file.'
        : 'Make sure no one is watching your screen.',
  )

  function methodLabel(type: AccessMethod['type']): string {
    return type === 'passkey' ? 'Passkey' : type === 'eth-wallet' ? 'ETH wallet' : 'Password'
  }

  function toggle(section: SectionId) {
    expanded[section] = !expanded[section]
  }

  function onNameChange() {
    const trimmed = name.trim()
    if (trimmed.length > 0 && trimmed !== account.name) {
      account.rename(trimmed)
    }
  }

  async function copyText(text: string, what: string) {
    if (await copyToClipboard(text)) {
      toastStore.show(`${what} copied to clipboard`)
    } else {
      toastStore.show('Could not copy to clipboard')
    }
  }

  // Called by the unlock dialog with the decrypted seed; a throw from
  // `complete` surfaces as a dialog error, so only success closes it.
  function onUnlocked(seed: Uint8Array) {
    const target = unlockTarget
    if (!target) {
      seed.fill(0)
      return
    }
    complete(target, seed)
    unlockTarget = undefined
  }

  // Consumes `seed`: zeroed here for transient targets, handed to the export /
  // change-method flows that zero it when they finish.
  function complete(target: UnlockTarget, seed: Uint8Array) {
    if (target === 'private-key') {
      revealedPrivateKey = privateKeyFromEntropy(seed)
      seed.fill(0)
    } else if (target === 'phrase') {
      revealedPhrase = phraseFromEntropy(seed).split(' ')
      seed.fill(0)
    } else if (target === 'export') {
      void exportBackupFile(seed)
    } else {
      changeMethodSeed = seed
      newMethod = 'passkey'
      newPassword = ''
      verifyNewPassword = ''
      dialogError = undefined
      setMethodDialog = 'form'
    }
  }

  function closeSetMethod() {
    // Invalidate any in-flight ceremony — wallet prompts can't be aborted, so
    // a later approval of a cancelled prompt must not complete.
    attempts.supersede()
    abortController?.abort()
    changeMethodSeed?.fill(0)
    changeMethodSeed = undefined
    setMethodDialog = undefined
    dialogError = undefined
    busy = false
    newPassword = ''
    verifyNewPassword = ''
  }

  async function confirmNewMethod() {
    if (busy || setMethodDialog === undefined || !changeMethodSeed) {
      return
    }
    const attempt = attempts.begin()
    dialogError = undefined
    busy = true
    if (newMethod !== 'password') {
      setMethodDialog = 'pending'
    }
    try {
      abortController = newMethod === 'passkey' ? new AbortController() : undefined
      const { access: newAccess, key } = await attempt.guard(
        createAccess(newMethod, {
          accountName: account.name,
          password: newPassword,
          signal: abortController?.signal,
        }),
      )
      // Guarded too: cancelling while the seed re-encrypts must not go on to
      // `setAccess` — the superseded attempt leaves the held seed alone, since
      // closeSetMethod owns destroying it and a retry's seed lives in the same
      // variable.
      const encryptedSeed = await attempt.guard(encryptSeed(changeMethodSeed, key))
      if (account.isSignedOut) {
        // Signed out mid-ceremony (e.g. cross-tab): `setAccess` would re-arm
        // the vault the sign-out just wiped. This is the live attempt, so the
        // held seed is ours to destroy.
        changeMethodSeed.fill(0)
        changeMethodSeed = undefined
        return
      }
      account.setAccess(newAccess, encryptedSeed)
      changeMethodSeed.fill(0)
      changeMethodSeed = undefined
      setMethodDialog = undefined
      newPassword = ''
      verifyNewPassword = ''
      toastStore.show('Unlock method updated')
    } catch (caught) {
      if (attempt.current) {
        dialogError = caught instanceof Error ? caught.message : 'Could not set the new method.'
        setMethodDialog = 'form'
      }
    } finally {
      if (attempt.current) {
        busy = false
        abortController = undefined
      }
    }
  }

  async function exportBackupFile(seed: Uint8Array) {
    const contents = await createBackup(account, seed)
    seed.fill(0)
    const blob = new Blob([contents], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = backupFilename(new Date())
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function downloadPhrase() {
    if (!revealedPhrase) {
      return
    }
    const blob = new Blob([revealedPhrase.join(' ')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'swarm-id-recovery-phrase.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }
</script>

{#snippet sectionHeader(id: SectionId, title: string, description: string)}
  <button
    id="account-{id}"
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

<div class="flex w-full flex-col gap-6">
  {#if isLocal}
    <!-- Local account banner: no stamps yet, so the account is view-only. -->
    <div class="bg-muted flex w-full flex-col gap-2 rounded-lg px-4 py-2">
      <div class="flex w-full items-center gap-2">
        <Info class="size-4 shrink-0" />
        <p class="flex-1 text-sm">Local account (view-only)</p>
        <Button size="xs" onclick={() => (addDriveOpen = true)}>Upgrade</Button>
        <Button size="xs" variant="ghost" onclick={() => (bannerInfoShown = !bannerInfoShown)}>
          Info
        </Button>
      </div>
      {#if bannerInfoShown}
        <p class="text-muted-foreground pl-6 text-sm">
          This is a local account, view-only and not synced. Upgrade by setting up a drive to upload
          data and use your Swarm ID across all your devices.
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
        <AccountAvatar
          value={account.id.toHex()}
          size={32}
          class="shrink-0 overflow-hidden rounded-lg"
        />
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
            onclick={() => (unlockTarget = 'change-method')}
          >
            <RefreshCw />
            Change
          </Button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Keys & addresses -->
  <div class="flex w-full flex-col gap-3">
    {@render sectionHeader(
      'keys',
      'Keys & addresses',
      "Your account's cryptographic identifiers and data sharing keys.",
    )}
    {#if expanded.keys}
      <div class="flex flex-col gap-3 pl-5">
        <KeyCard
          id="account-keys-account-identity"
          title="Account identity"
          address={{
            label: 'Address',
            description: 'The unique identifier for your Swarm ID.',
            value: account.id.toChecksum(),
          }}
          publicKey={{
            label: 'Public key',
            description: 'Can be used for establishing secure, private communication.',
            value: publicKeyDisplay,
          }}
          privateKey={{
            label: 'Private key',
            description: 'Grants full control over your account. Never share it.',
          }}
          bind:revealed={revealedPrivateKey}
          onreveal={() => (unlockTarget = 'private-key')}
          bind:open={keysDetailOpen}
        />

        <KeyCard
          id="account-keys-data-sharing"
          title="Data sharing"
          address={{
            label: 'Sharing address',
            description: 'The unique identifier for your data sharing key.',
            value: sharingAddress,
          }}
          publicKey={{
            label: 'Sharing public key',
            description: 'Used by apps to securely share data with each other.',
            value: sharingKeyDisplay,
          }}
          privateKey={{
            label: 'Sharing private key',
            description: 'Grants access to shared data. Never share it.',
          }}
          bind:revealed={revealedSharingKey}
          onreveal={() => (revealedSharingKey = sharingPrivateKeyDisplay)}
          bind:open={sharingDetailOpen}
        />

        <KeyCard
          id="account-keys-drive-management"
          title="Drive management"
          address={{
            label: 'Postage batch signer address',
            description: 'Manage drives for your account.',
            value: signerAddress,
          }}
          privateKey={{
            label: 'Postage batch signer private key',
            description: 'Used to transfer ownership of your drives. Never share it.',
          }}
          bind:revealed={revealedSignerKey}
          onreveal={() => (revealedSignerKey = signerPrivateKeyDisplay)}
          bind:open={signerDetailOpen}
        />
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
        {#if revealedPhrase}
          <PhraseGrid words={revealedPhrase} />
          <div class="flex w-full items-center gap-4">
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy phrase"
                onclick={() => revealedPhrase && copyText(revealedPhrase.join(' '), 'Seed phrase')}
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
          <Button variant="outline" class="w-full" onclick={() => (revealedPhrase = undefined)}>
            <EyeOff />
            Hide secret recovery phrase
          </Button>
        {:else}
          <div
            class="border-border flex h-38 w-full flex-col items-center justify-center gap-2 rounded-lg border"
          >
            <Button variant="ghost" onclick={() => (unlockTarget = 'phrase')}>
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
        <Button variant="outline" onclick={() => (unlockTarget = 'export')}>
          <FileDown />
          Export .swarmid file
        </Button>
      </div>
    {/if}
  </div>

  <div class="bg-border h-px w-full"></div>

  <div class="flex w-full items-center justify-between">
    {#if isLocal}
      <!-- A local account only exists on this device: nothing to sign out of. -->
      <span></span>
    {:else}
      <Button variant="outline" onclick={() => (signingOut = true)}>Sign out</Button>
    {/if}
    <Button variant="destructive" onclick={() => (deleting = true)}>Delete account</Button>
  </div>
</div>

{#if unlockTarget}
  <UnlockDialog
    {account}
    title={unlockTitle}
    description={unlockDescription}
    onunlocked={onUnlocked}
    onclose={() => (unlockTarget = undefined)}
  />
{:else if setMethodDialog === 'pending'}
  <Dialog onclose={closeSetMethod} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-2">
      <LoaderCircle class="size-5 animate-spin" />
      <div class="flex flex-col items-center text-center">
        <p class="text-sm font-bold">
          {newMethod === 'eth-wallet' ? 'Confirm with new wallet' : 'Confirm with new passkey'}
        </p>
        <p class="text-sm">
          {newMethod === 'eth-wallet'
            ? 'Approve the request in your Ethereum wallet. It may ask a second time.'
            : 'Follow the prompts on your device.'}
        </p>
      </div>
    </div>
    <Button variant="outline" class="w-full" onclick={closeSetMethod}>Cancel</Button>
  </Dialog>
{:else if setMethodDialog === 'form'}
  <Dialog onclose={closeSetMethod} title="Set new unlock method">
    <Tabs tabs={METHOD_TABS} bind:value={newMethod} />

    {#if newMethod === 'passkey'}
      <p class="text-sm">
        Unlock with your device&rsquo;s built-in authentication &mdash; fingerprint, face, or PIN.
      </p>
    {:else if newMethod === 'eth-wallet'}
      <p class="text-sm">
        Unlock by signing a message with your Ethereum wallet. Your wallet may ask you to sign it a
        second time, to confirm it signs the same way each time.
      </p>
    {:else}
      <NewPasswordFields bind:password={newPassword} bind:verify={verifyNewPassword} />
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

{#if addDriveOpen}
  <DriveAddDialog {account} onClose={() => (addDriveOpen = false)} onAdded={toastStore.show} />
{/if}

{#if signingOut}
  <SignOutDialog {account} onClose={() => (signingOut = false)} />
{/if}

{#if deleting}
  <DeleteAccountDialog {account} onClose={() => (deleting = false)} />
{/if}
