<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { goto } from '$app/navigation'
  import Typography from '$lib/components/ui/typography.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import Select from '$lib/components/ui/select/select.svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import Information from 'carbon-icons-svelte/lib/Information.svelte'
  import routes from '$lib/routes'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { resolve } from '$app/paths'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Tooltip from '$lib/components/ui/tooltip.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { requestWalletKeySource, deriveWalletKey } from '$lib/crypto/eth-wallet'
  import { encryptSeed, randomSalt } from '$lib/crypto/encryption'
  import { bytesToHex } from '$lib/crypto/hex'
  import { walletFromPhrase, privateKeyFromEntropy } from '$lib/crypto/mnemonic'
  import { Wallet } from 'ethers'
  import { EthAddress } from '@ethersphere/bee-js'
  import { WarningAlt } from 'carbon-icons-svelte'
  import Confirmation from '$lib/components/confirmation.svelte'
  import { onMount } from 'svelte'
  import {
    deriveAccountDerivationKey,
    getOrCreateDeviceId,
    mergeDevices,
    detectDeviceName,
    PARTITION_COUNT,
  } from '@snaha/swarm-id'
  import type { AccountSyncType } from '$lib/types'

  let showTypeTooltip = $state(false)
  let accountName = $state('Ethereum')
  let accountType = $state<AccountSyncType>('local')
  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)

  const accountTypeItems = [
    { value: 'local', label: 'Local' },
    { value: 'synced', label: 'Synced' },
  ]

  onMount(() => {
    const accountNameIsTaken = accountsStore.accounts.some(
      (account) => account.name === accountName,
    )
    if (accountNameIsTaken) {
      accountName = `${accountName} ${accountsStore.accounts.length + 1}`
    }
  })

  let isFormDisabled = $derived(!accountName)

  async function handleConfirm() {
    if (!accountName.trim()) {
      error = 'Please enter an account name'
      return
    }

    try {
      isProcessing = true
      error = undefined

      // Unified seed account: generate a BIP-39 phrase and encrypt its entropy
      // with a key derived from a wallet signature. Re-signing the same message
      // with the same wallet unlocks the seed on this device.
      const phrase = Wallet.createRandom().mnemonic!.phrase
      const wallet = walletFromPhrase(phrase)

      const source = await requestWalletKeySource()
      const salt = randomSalt()
      const key = await deriveWalletKey(source, salt)
      const encryptedSeed = await encryptSeed(wallet.entropy, key)

      const masterKeyHex = privateKeyFromEntropy(wallet.entropy)
      const derivationKey = await deriveAccountDerivationKey(masterKeyHex)

      const deviceId = getOrCreateDeviceId()
      const newAccount = accountsStore.addAccount({
        id: new EthAddress(wallet.address),
        createdAt: Date.now(),
        name: accountName.trim(),
        publicKey: wallet.publicKey,
        access: {
          type: 'eth-wallet',
          encryptionSalt: bytesToHex(salt),
        },
        encryptedSeed,
        derivationKey,
        devices: mergeDevices([], deviceId, detectDeviceName()),
        connectedApps: [],
        postageStamps: [],
        // Multi-device partition lease: opt new accounts into K=2 sharing
        // from day one. Lock SOCs are claimed on demand by the proxy.
        partitionCount: PARTITION_COUNT,
      })
      sessionStore.setAccount(newAccount)
      sessionStore.setSyncedCreation(accountType === 'synced')

      // Synced accounts buy a default stamp next; local accounts are ready.
      if (accountType === 'synced') {
        goto(resolve(routes.STAMPS_ACCOUNT_NEW))
      } else {
        navigateToConnectOrHome()
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to connect wallet'
      console.error('❌ Wallet connection failed:', err)
      console.error(error)
      isProcessing = false
    }
  }
</script>

{#if isProcessing}
  <Confirmation authenticationType="ethereum" />
{:else}
  <CreationLayout
    title="Sign up with Ethereum"
    description="Create a Swarm ID account using your Ethereum wallet"
    onClose={navigateToConnectOrHome}
  >
    {#snippet content()}
      <Vertical --vertical-gap="var(--padding)">
        <div class="form-row">
          <div class="form-field account-name">
            <Input
              variant="outline"
              dimension="compact"
              name="account-name"
              bind:value={accountName}
              placeholder="Enter account name"
              disabled={isProcessing}
              label="Account name"
            />
          </div>
          <div class="form-field account-type">
            <Select
              variant="outline"
              dimension="compact"
              label="Account type"
              bind:value={accountType}
              items={accountTypeItems}
            />
          </div>
          <div class="info-button">
            <Tooltip
              show={showTypeTooltip}
              position="bottom"
              variant="small"
              color="dark"
              maxWidth="279px"
            >
              <Button
                dimension="compact"
                variant="ghost"
                onmouseenter={() => (showTypeTooltip = true)}
                onmouseleave={() => (showTypeTooltip = false)}
                onclick={(e: MouseEvent) => {
                  e.stopPropagation()
                  showTypeTooltip = !showTypeTooltip
                }}
              >
                <Information size={20} />
              </Button>
              {#snippet helperText()}
                Local accounts are free and faster to set up but are limited to viewing content on
                this device. Synced accounts enable uploading data and syncing across devices but
                require purchasing a Swarm postage stamp. <strong
                  >Not sure yet? You can always upgrade from Local to Synced later.</strong
                >
              {/snippet}
            </Tooltip>
          </div>
        </div>

        <Typography variant="small"
          >A fresh recovery phrase is generated for you and encrypted on this device with your
          Ethereum wallet. Sign the message in your wallet to continue.</Typography
        >

        {#if error}
          <Horizontal
            --horizontal-gap="var(--quarter-padding)"
            style="background: var(--colors-red); padding: var(--half-padding); color: var(--colors-ultra-low)"
          >
            <WarningAlt size={20} />
            <Typography --typography-color="var(--colors-ultra-low)">{error}</Typography>
          </Horizontal>
        {/if}
      </Vertical>
    {/snippet}

    {#snippet buttonContent()}
      <Vertical --vertical-gap="var(--half-padding)">
        <Button
          dimension="compact"
          onclick={handleConfirm}
          disabled={isFormDisabled}
          class="mobile-full-width"
        >
          {isProcessing ? 'Processing...' : 'Confirm with wallet'}
          <span class="mobile-only"
            >{#if !isProcessing}<ArrowRight size={20} />{/if}</span
          >
        </Button>
        {#if !isFormDisabled}
          <Typography variant="small"
            >For security, use a fresh Ethereum wallet without existing onchain activity.</Typography
          >
        {/if}
      </Vertical>
    {/snippet}
  </CreationLayout>
{/if}

<style>
  .form-row {
    display: flex;
    gap: var(--half-padding);
    align-items: flex-end;
  }

  .form-field {
    flex: 1;
    min-width: 0;
  }

  .info-button {
    flex-shrink: 0;
  }

  .mobile-only {
    display: none;
  }

  @media screen and (max-width: 640px) {
    .form-row {
      flex-wrap: wrap;
    }

    .account-name {
      width: 100%;
      flex: none;
    }

    .account-type {
      flex: 1;
    }

    .mobile-only {
      display: inline-flex;
    }
  }
</style>
