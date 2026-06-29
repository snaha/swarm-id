<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { onMount } from 'svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import ErrorMessage from '$lib/components/ui/error-message.svelte'
  import ErrorOverlay from '$lib/components/error-overlay.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import Confirmation from '$lib/components/confirmation.svelte'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { validateSeedPhrase, countSeedPhraseWords } from '$lib/seed-phrase'
  import { secureSeedWithPassword } from '$lib/utils/account-auth'
  import { walletFromPhrase, privateKeyFromEntropy } from '$lib/crypto/mnemonic'
  import {
    decryptEncryptedExport,
    deriveAccountDerivationKey,
    deriveSwarmEncryptionKey,
  } from '@snaha/swarm-id'
  import { EthAddress, BatchId, Bytes } from '@ethersphere/bee-js'
  import { restoreAccountToStores } from '$lib/utils/restore-account'

  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)
  let seedPhrase = $state('')
  let password = $state('')

  const fileData = $derived(sessionStore.data.importFileData)

  const wordCount = $derived(countSeedPhraseWords(seedPhrase))
  const seedPhraseValidation = $derived.by(() => {
    if (!seedPhrase.trim()) return undefined
    return validateSeedPhrase(seedPhrase)
  })
  const seedPhraseError = $derived.by(() => {
    if (!seedPhraseValidation) return undefined
    if (seedPhraseValidation.valid) return undefined
    return seedPhraseValidation.error
  })
  const isConfirmDisabled = $derived(!seedPhraseValidation?.valid || !password)

  onMount(() => {
    if (!sessionStore.data.importHeader || !fileData) {
      goto(resolve(routes.HOME))
    }
  })

  async function handleConfirm() {
    const validation = validateSeedPhrase(seedPhrase)
    if (!validation.valid || !fileData) {
      error = validation.valid ? 'Missing backup file.' : validation.error
      return
    }

    try {
      isProcessing = true
      error = undefined

      // Unified model: the recovery phrase recomputes the master key, and the
      // backup is decrypted with the swarmEncryptionKey derived from it. The
      // backup carries no key material and no account type.
      const wallet = walletFromPhrase(validation.phrase)
      const accountId = new EthAddress(wallet.address)
      const masterKey = new Bytes(privateKeyFromEntropy(wallet.entropy))

      const existingAccount = accountsStore.getAccount(accountId)
      if (existingAccount) {
        error = 'Account already exists on this device. Go back to the home screen to select it.'
        isProcessing = false
        return
      }

      const derivationKey = await deriveAccountDerivationKey(masterKey.toHex())
      const swarmEncryptionKey = await deriveSwarmEncryptionKey(derivationKey)

      const result = await decryptEncryptedExport(fileData, swarmEncryptionKey)

      if (!result.success) {
        error = 'Decryption failed. Make sure you entered the correct recovery phrase.'
        isProcessing = false
        return
      }

      // Secure the recovered seed locally with the password so the imported
      // account carries the required access vault (unlocked by re-entering the
      // password on this device).
      const vault = await secureSeedWithPassword(wallet.entropy, password)
      const account = restoreAccountToStores({
        id: accountId,
        createdAt: result.data.metadata.createdAt,
        name: result.data.metadata.accountName,
        publicKey: result.data.metadata.publicKey ?? wallet.publicKey,
        derivationKey,
        access: vault.access,
        encryptedSeed: vault.encryptedSeed,
        defaultPostageStampBatchID: result.data.metadata.defaultPostageStampBatchID
          ? new BatchId(result.data.metadata.defaultPostageStampBatchID)
          : undefined,
        devices: result.data.metadata.devices,
        connectedApps: result.data.connectedApps,
        postageStamps: result.data.postageStamps,
        settings: result.data.metadata.settings,
        partitionCount: result.data.metadata.partitionCount,
      })

      sessionStore.setAccount(account)
      sessionStore.setTemporaryMasterKey(masterKey)
      sessionStore.clearImportData()

      navigateToConnectOrHome()
    } catch (err) {
      console.error('🔑 Backup import failed:', err)
      error = 'Import failed. Make sure you entered the correct recovery phrase.'
      isProcessing = false
    }
  }

  function handleTryAgain() {
    error = undefined
    isProcessing = false
  }

  function handleClose() {
    sessionStore.clearImportData()
    goto(resolve(routes.HOME))
  }
</script>

{#if error}
  <ErrorOverlay title="Import failed" description={error} onTryAgain={handleTryAgain} />
{:else if isProcessing}
  <Confirmation authenticationType="agent" />
{:else}
  <CreationLayout title="Import account" onClose={handleClose}>
    {#snippet content()}
      <Vertical --vertical-gap="var(--padding)">
        <Typography>
          Enter the recovery phrase for this backup to decrypt and import your Swarm ID account.
        </Typography>

        <Vertical --vertical-gap="var(--quarter-padding)">
          <Horizontal --horizontal-justify-content="space-between">
            <Typography>Recovery phrase</Typography>
            <Typography variant="small">{wordCount} words</Typography>
          </Horizontal>
          <textarea
            class="seed-phrase-input"
            bind:value={seedPhrase}
            placeholder="Enter your 12 or 24 word recovery phrase..."
            rows="3"
            disabled={isProcessing}
          ></textarea>
          {#if seedPhraseError}
            <ErrorMessage>{seedPhraseError}</ErrorMessage>
          {/if}
        </Vertical>

        <Vertical --vertical-gap="var(--quarter-padding)">
          <Input
            variant="outline"
            dimension="compact"
            type="password"
            name="account-password"
            bind:value={password}
            placeholder="Enter a password"
            disabled={isProcessing}
            label="Password"
          />
          <Typography variant="small"
            >Set a password to encrypt the imported recovery phrase on this device. You'll re-enter
            it to unlock the account.</Typography
          >
        </Vertical>
      </Vertical>
    {/snippet}

    {#snippet buttonContent()}
      <Button
        dimension="compact"
        onclick={handleConfirm}
        disabled={isConfirmDisabled}
        class="mobile-full-width"
      >
        Import account
        <ArrowRight size={20} />
      </Button>
    {/snippet}
  </CreationLayout>
{/if}

<style>
  .seed-phrase-input {
    width: 100%;
    padding: var(--half-padding);
    border: 1px solid var(--colors-low);
    border-radius: 4px;
    font-family: var(--typography-font-family-mono);
    font-size: var(--typography-font-size-base);
    resize: vertical;
    min-height: 80px;
  }

  .seed-phrase-input:focus {
    outline: none;
    border-color: var(--colors-high);
  }
</style>
