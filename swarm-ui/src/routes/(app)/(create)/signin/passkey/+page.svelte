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
  import { getMasterKeyFromAccount } from '$lib/utils/account-auth'

  let error = $state<string | undefined>(undefined)
  let isProcessing = $state(false)

  async function handleConfirmPasskey() {
    try {
      isProcessing = true
      error = undefined

      // Unified model: a passkey account stores its seed encrypted on THIS
      // device (the passkey only gates the decryption key). Cross-device
      // restore from a passkey alone is therefore not possible — the account
      // must already exist locally. Unlock the first passkey account found on
      // this device.
      const account = accountsStore.accounts.find((a) => a.access?.type === 'passkey')

      if (!account) {
        error =
          'No passkey account found on this device. Passkey accounts can only be unlocked on the device where they were created, or restored from a .swarmid backup file.'
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
