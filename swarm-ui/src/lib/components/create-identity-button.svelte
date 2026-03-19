<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Add from 'carbon-icons-svelte/lib/Add.svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { sessionStore } from '$lib/stores/session.svelte'
  import routes from '$lib/routes'
  import {
    getMasterKeyFromAccount,
    SeedPhraseRequiredError,
    getMasterKeyFromAgentAccount,
  } from '$lib/utils/account-auth'
  import type { Account } from '$lib/types'
  import EnterSeedModal from '$lib/components/enter-seed-modal.svelte'

  interface Props {
    account?: Account
    /** Whether to show the Add icon. Default: true */
    showIcon?: boolean
    isAuthenticating?: boolean
  }

  let { account, showIcon = true, isAuthenticating = $bindable(false) }: Props = $props()
  let showSeedModal = $state(false)

  async function handleClick() {
    if (!account) return

    try {
      isAuthenticating = true
      const masterKey = await getMasterKeyFromAccount(account)
      sessionStore.setAccount(account)
      sessionStore.setTemporaryMasterKey(masterKey)
      sessionStore.setSyncedCreation(account.defaultPostageStampBatchID !== undefined)
      goto(resolve(routes.IDENTITY_NEW))
    } catch (err) {
      if (err instanceof SeedPhraseRequiredError) {
        // Agent accounts need seed phrase - show modal
        showSeedModal = true
        isAuthenticating = false
        return
      }
      console.error('Failed to authenticate:', err)
      isAuthenticating = false
    }
  }

  function handleSeedPhraseProvided(seedPhrase: string) {
    if (!account) return

    try {
      const masterKey = getMasterKeyFromAgentAccount(account, seedPhrase)
      sessionStore.setAccount(account)
      sessionStore.setTemporaryMasterKey(masterKey)
      sessionStore.setSyncedCreation(account.defaultPostageStampBatchID !== undefined)
      goto(resolve(routes.IDENTITY_NEW))
    } catch (err) {
      console.error('Invalid seed phrase:', err)
    }
  }

  function handleSeedModalCancel() {
    isAuthenticating = false
  }
</script>

<Button variant="ghost" dimension="compact" leftAlign onclick={handleClick}>
  {#if showIcon}<Add size={20} />{/if}Create new identity
</Button>

<EnterSeedModal
  bind:open={showSeedModal}
  onUnlock={handleSeedPhraseProvided}
  onCancel={handleSeedModalCancel}
/>
