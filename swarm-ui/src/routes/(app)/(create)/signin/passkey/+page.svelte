<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import ErrorOverlay from '$lib/components/error-overlay.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import Confirmation from '$lib/components/confirmation.svelte'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
  import { authenticateWithPasskey } from '$lib/passkey'
  import { restoreAccountFromSwarm, SnapshotDataUnavailableError } from '@snaha/swarm-id'
  import { Bee, BatchId } from '@ethersphere/bee-js'
  import { restoreAccountToStores } from '$lib/utils/restore-account'

  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)

  async function handleConfirmPasskey() {
    try {
      isProcessing = true
      error = undefined

      const passkeyAccount = await authenticateWithPasskey()

      const account = accountsStore.accounts.find(
        (a) => a.type === 'passkey' && a.credentialId === passkeyAccount.credentialId,
      )

      if (account) {
        error = 'Account already exists on this device. Go back to the home screen to select it.'
        isProcessing = false
        return
      }

      // No local account — attempt to restore from Swarm
      const bee = new Bee(networkSettingsStore.beeNodeUrl)
      let result: Awaited<ReturnType<typeof restoreAccountFromSwarm>>
      try {
        result = await restoreAccountFromSwarm(
          bee,
          passkeyAccount.masterKey,
          passkeyAccount.ethereumAddress,
          passkeyAccount.credentialId,
        )
      } catch (err) {
        console.error('🔑 Swarm restore failed:', err)
        if (err instanceof SnapshotDataUnavailableError) {
          const refPreview = err.reference.slice(0, 8)
          error = `Found your account backup but couldn't retrieve it from Swarm. The Bee node may not have the data yet, or you may be connected to a different node than where it was uploaded. (ref: ${refPreview}…)`
        } else {
          error = 'Could not reach the Swarm network. Please check your connection and try again.'
        }
        isProcessing = false
        return
      }

      if (!result) {
        error =
          'Sign in failed. Make sure you are using the same Passkey used during account creation.'
        isProcessing = false
        return
      }

      // Restore account to local stores
      const restoredAccount = restoreAccountToStores({
        account: {
          id: passkeyAccount.ethereumAddress,
          createdAt: result.snapshot.metadata.createdAt,
          name: result.snapshot.metadata.accountName,
          type: 'passkey',
          credentialId: passkeyAccount.credentialId,
          derivationKey: result.derivationKey,
          defaultPostageStampBatchID: result.snapshot.metadata.defaultPostageStampBatchID
            ? new BatchId(result.snapshot.metadata.defaultPostageStampBatchID)
            : undefined,
          devices: [],
          // Carry forward multi-device partition-lease state from the snapshot
          // so the proxy's PartitionLease.acquire can find this device's
          // partition (or auto-acquire a free one).
          activeDevices: result.snapshot.metadata.activeDevices,
          partitionCount: result.snapshot.metadata.partitionCount,
        },
        identities: result.snapshot.identities,
        connectedApps: result.snapshot.connectedApps,
        postageStamps: result.snapshot.postageStamps,
        devices: result.snapshot.metadata.devices,
      })

      sessionStore.setAccount(restoredAccount)
      sessionStore.setTemporaryMasterKey(passkeyAccount.masterKey)
      navigateToConnectOrHome()
    } catch (err) {
      console.error('🔑 Passkey sign-in failed:', err)
      error =
        'Sign in failed. Make sure you are using the same Passkey used during account creation.'
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
  <Confirmation authenticationType="passkey" />
{:else}
  <CreationLayout title="Sign in with Passkey" onClose={handleClose}>
    {#snippet content()}
      <Typography>
        Make sure to use the same Passkey you used to create your Swarm ID account.
      </Typography>
    {/snippet}

    {#snippet buttonContent()}
      <Button dimension="compact" onclick={handleConfirmPasskey} class="mobile-full-width">
        Confirm with Passkey
        <ArrowRight size={20} />
      </Button>
    {/snippet}
  </CreationLayout>
{/if}
