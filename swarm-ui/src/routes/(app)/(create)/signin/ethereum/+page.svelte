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
  import Vertical from '$lib/components/ui/vertical.svelte'
  import ErrorOverlay from '$lib/components/error-overlay.svelte'
  import CreationLayout from '$lib/components/creation-layout.svelte'
  import Confirmation from '$lib/components/confirmation.svelte'
  import routes from '$lib/routes'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { navigateToConnectOrHome } from '$lib/utils/navigation'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { getMasterKeyFromAccount } from '$lib/utils/account-auth'

  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)

  async function handleConfirm() {
    try {
      isProcessing = true
      error = undefined

      // Unified model: an Ethereum-secured account stores its seed encrypted on
      // THIS device (the wallet signature only gates the decryption key).
      // Cross-device restore from a wallet alone is therefore not possible — the
      // account must already exist locally, or be restored from a .swarmid file.
      const account = accountsStore.accounts.find((a) => a.access?.type === 'eth-wallet')

      if (!account) {
        error =
          'No Ethereum-secured account found on this device. Sign in is only available on the device where the account was created, or restore from a .swarmid backup file.'
        isProcessing = false
        return
      }

      const masterKey = await getMasterKeyFromAccount(account)

      sessionStore.setAccount(account)
      sessionStore.setTemporaryMasterKey(masterKey)
      // The proxy claims a partition on demand (and eagerly on auth) — no
      // lease management in the UI.
      navigateToConnectOrHome()
    } catch (err) {
      console.error('🔑 Ethereum sign-in failed:', err)
      error =
        'Sign in failed. Make sure you are using the same Ethereum wallet you used during account creation.'
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
      <Typography>
        Sign the message in your Ethereum wallet to unlock your Swarm ID account on this device.
      </Typography>
    {/snippet}

    {#snippet buttonContent()}
      <Vertical --vertical-gap="var(--half-padding)">
        <Button dimension="compact" onclick={handleConfirm} class="mobile-full-width">
          Confirm with wallet
          <ArrowRight size={20} />
        </Button>
        <Typography variant="small">
          Make sure to use the same Ethereum wallet you used to create your Swarm ID account.
        </Typography>
      </Vertical>
    {/snippet}
  </CreationLayout>
{/if}
