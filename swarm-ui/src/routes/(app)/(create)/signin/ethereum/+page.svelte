<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
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
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { connectAndSign, deriveMasterKey } from '$lib/ethereum'
  import { restoreAccountFromSwarm, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
  import { Bee, BatchId, EthAddress } from '@ethersphere/bee-js'
  import { restoreAccountToStores } from '$lib/utils/restore-account'
  import {
    generateEncryptionSalt,
    deriveEncryptionKey,
    encryptMasterKey,
    deriveSecretSeedEncryptionKey,
    encryptSecretSeed,
  } from '$lib/utils/encryption'

  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)
  let secretSeed = $state('')
  let isConfirmDisabled = $derived(!secretSeed.trim())

  async function handleConfirm() {
    try {
      isProcessing = true
      error = undefined

      const signed = await connectAndSign()
      const { masterKey, masterAddress } = deriveMasterKey(secretSeed, signed.publicKey)

      let account = accountsStore.accounts.find(
        (a) =>
          a.type === 'ethereum' &&
          a.ethereumAddress.toHex() === signed.address.toLowerCase().replace('0x', ''),
      )

      if (account) {
        error = 'Account already exists on this device. Go back to the home screen to select it.'
        isProcessing = false
        return
      } else {
        // No local account — attempt to restore from Swarm
        const bee = new Bee(networkSettingsStore.beeNodeUrl)
        let result: Awaited<ReturnType<typeof restoreAccountFromSwarm>>
        try {
          result = await restoreAccountFromSwarm(
            bee,
            masterKey,
            masterAddress,
            '', // credentialId is passkey-only, not used for ethereum
          )
        } catch (err) {
          console.error('🔑 Swarm restore failed:', err)
          error = 'Could not reach the Swarm network. Please check your connection and try again.'
          isProcessing = false
          return
        }

        if (!result) {
          error =
            'Sign in failed. Make sure you are using the correct wallet and secret seed combination used during account creation.'
          isProcessing = false
          return
        }

        // Re-encrypt keys with fresh salt for local storage
        const encryptionSalt = generateEncryptionSalt()
        const encryptionKey = await deriveEncryptionKey(signed.publicKey, encryptionSalt)
        const encryptedMasterKey = await encryptMasterKey(masterKey, encryptionKey)
        const secretSeedEncryptionKey = await deriveSecretSeedEncryptionKey(masterKey)
        const encryptedSecretSeed = await encryptSecretSeed(secretSeed, secretSeedEncryptionKey)
        const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(masterKey.toHex())

        account = restoreAccountToStores({
          account: {
            id: masterAddress,
            createdAt: result.snapshot.metadata.createdAt,
            name: result.snapshot.metadata.accountName,
            type: 'ethereum',
            ethereumAddress: new EthAddress(signed.address),
            encryptedMasterKey,
            encryptionSalt,
            encryptedSecretSeed,
            swarmEncryptionKey,
            defaultPostageStampBatchID: result.snapshot.metadata.defaultPostageStampBatchID
              ? new BatchId(result.snapshot.metadata.defaultPostageStampBatchID)
              : undefined,
          },
          identities: result.snapshot.identities,
          connectedApps: result.snapshot.connectedApps,
          postageStamps: result.snapshot.postageStamps,
        })
      }

      sessionStore.setAccount(account)
      sessionStore.setTemporaryMasterKey(masterKey)
      navigateToConnectOrHome()
    } catch (err) {
      console.error('🔑 Ethereum sign-in failed:', err)
      error =
        'Sign in failed. Make sure you are using the correct wallet and secret seed combination used during account creation.'
      isProcessing = false
    }
  }

  function handleTryAgain() {
    error = undefined
    isProcessing = false
  }

  function handleClose() {
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
          onclick={handleConfirm}
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
