<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { onMount } from 'svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import SecretSeedInput from '$lib/components/secret-seed-input.svelte'
  import ErrorOverlay from '$lib/components/error-overlay.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import Confirmation from '$lib/components/confirmation.svelte'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { connectAndSign, deriveMasterKey } from '$lib/ethereum'
  import {
    generateEncryptionSalt,
    deriveEncryptionKey,
    encryptMasterKey,
    deriveSecretSeedEncryptionKey,
    encryptSecretSeed,
  } from '$lib/utils/encryption'
  import { decryptEncryptedExport, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
  import { EthAddress, BatchId } from '@ethersphere/bee-js'
  import { restoreAccountToStores } from '$lib/utils/restore-account'

  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)
  let secretSeed = $state('')
  let isConfirmDisabled = $derived(!secretSeed.trim())

  const header = $derived(sessionStore.data.importHeader)
  const fileData = $derived(sessionStore.data.importFileData)

  onMount(() => {
    if (!header || !fileData || header.accountType !== 'ethereum') {
      goto(resolve(routes.HOME))
    }
  })

  async function handleConfirmEthereum() {
    if (!header || header.accountType !== 'ethereum' || !fileData) return

    try {
      isProcessing = true
      error = undefined

      const signed = await connectAndSign()

      const signedAddressHex = signed.address.toLowerCase().replace('0x', '')
      if (signedAddressHex !== header.ethereumAddress.toLowerCase()) {
        error =
          'Wrong wallet. Make sure to use the same Ethereum wallet you used to create your Swarm ID account.'
        isProcessing = false
        return
      }

      const existingAccount = accountsStore.accounts.find(
        (a) => a.type === 'ethereum' && a.ethereumAddress.toString() === signedAddressHex,
      )
      if (existingAccount) {
        error = 'Account already exists on this device. Go back to the home screen to select it.'
        isProcessing = false
        return
      }

      const { masterKey, masterAddress } = deriveMasterKey(secretSeed, signed.publicKey)
      const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(masterKey.toHex())

      const result = await decryptEncryptedExport(fileData, swarmEncryptionKey)

      if (!result.success) {
        error = 'Decryption failed. Make sure you used the correct secret seed and Ethereum wallet.'
        isProcessing = false
        return
      }

      // Re-encrypt keys with fresh salt for local storage
      const encryptionSalt = generateEncryptionSalt()
      const encryptionKey = await deriveEncryptionKey(signed.publicKey, encryptionSalt)
      const encryptedMasterKey = await encryptMasterKey(masterKey, encryptionKey)
      const secretSeedEncryptionKey = await deriveSecretSeedEncryptionKey(masterKey)
      const encryptedSecretSeed = await encryptSecretSeed(secretSeed, secretSeedEncryptionKey)

      const account = restoreAccountToStores({
        account: {
          id: masterAddress,
          createdAt: result.data.metadata.createdAt,
          name: result.data.metadata.accountName,
          type: 'ethereum',
          ethereumAddress: new EthAddress(signed.address),
          encryptedMasterKey,
          encryptionSalt,
          encryptedSecretSeed,
          swarmEncryptionKey,
          defaultPostageStampBatchID: result.data.metadata.defaultPostageStampBatchID
            ? new BatchId(result.data.metadata.defaultPostageStampBatchID)
            : undefined,
        },
        identities: result.data.identities,
        connectedApps: result.data.connectedApps,
        postageStamps: result.data.postageStamps,
      })

      sessionStore.setAccount(account)
      sessionStore.setTemporaryMasterKey(masterKey)
      sessionStore.clearImportData()

      navigateToConnectOrHome()
    } catch (err) {
      console.error('🔑 Ethereum import failed:', err)
      error =
        'Authentication failed. Make sure you used the correct secret seed and Ethereum wallet.'
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
  <ErrorOverlay title="Sign in failed" description={error} onTryAgain={handleTryAgain} />
{:else if isProcessing}
  <Confirmation authenticationType="ethereum" />
{:else}
  <CreationLayout title="Sign in with Ethereum" onClose={handleClose}>
    {#snippet content()}
      <Vertical --vertical-gap="var(--padding)">
        <Typography>Enter the secret seed for your Swarm ID account.</Typography>

        <Vertical --vertical-gap="var(--quarter-padding)">
          <Typography>Secret seed</Typography>
          <SecretSeedInput bind:value={secretSeed} />
        </Vertical>
      </Vertical>
    {/snippet}

    {#snippet buttonContent()}
      <Vertical --vertical-gap="var(--half-padding)">
        <Button
          dimension="compact"
          onclick={handleConfirmEthereum}
          disabled={isConfirmDisabled}
          class="mobile-full-width"
        >
          Confirm with wallet
          <ArrowRight size={20} />
        </Button>
        {#if !isConfirmDisabled}
          <Typography variant="small">
            Make sure to use the same Ethereum wallet you used to create your Swarm ID account.
          </Typography>
        {/if}
      </Vertical>
    {/snippet}
  </CreationLayout>
{/if}
