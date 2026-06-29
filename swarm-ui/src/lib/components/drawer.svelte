<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import { page } from '$app/state'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import routes from '$lib/routes'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { notImplemented } from '$lib/utils/not-implemented'
  import Add from 'carbon-icons-svelte/lib/Add.svelte'
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
  import ChevronLeft from 'carbon-icons-svelte/lib/ChevronLeft.svelte'
  import ChevronRight from 'carbon-icons-svelte/lib/ChevronRight.svelte'
  import CloseLarge from 'carbon-icons-svelte/lib/CloseLarge.svelte'
  import Export from 'carbon-icons-svelte/lib/Export.svelte'
  import ContentDeliveryNetwork from 'carbon-icons-svelte/lib/ContentDeliveryNetwork.svelte'
  import Information from 'carbon-icons-svelte/lib/Information.svelte'
  import Rocket from 'carbon-icons-svelte/lib/Rocket.svelte'
  import TrashCan from 'carbon-icons-svelte/lib/TrashCan.svelte'
  import Logout from 'carbon-icons-svelte/lib/Logout.svelte'
  import NetworkSettingsModal from './network-settings-modal.svelte'
  import ThemeToggle from './theme-toggle.svelte'
  import FlexItem from '$lib/components/ui/flex-item.svelte'
  import Divider from '$lib/components/ui/divider.svelte'
  import Badge from '$lib/components/ui/badge.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import {
    createEncryptedExport,
    deriveSwarmEncryptionKey,
    SWARM_SECRET_PREFIX,
  } from '@snaha/swarm-id'
  import type { Account } from '$lib/types'
  import { getMasterKeyFromAccount } from '$lib/utils/account-auth'
  import EthereumLogo from './ethereum-logo.svelte'
  import PasskeyLogo from './passkey-logo.svelte'
  import Input from './ui/input/input.svelte'
  import Typography from './ui/typography.svelte'
  import CopyButton from './copy-button.svelte'
  import Tooltip from './ui/tooltip.svelte'
  import DeleteModal from './delete-modal.svelte'
  import EnterPasswordModal from './enter-password-modal.svelte'
  import Bot from 'carbon-icons-svelte/lib/Bot.svelte'

  type Props = {
    drawerOpen: boolean
    account: Account
    accounts: Account[]
  }

  let { drawerOpen = $bindable(), account, accounts }: Props = $props()

  let screen = $state<'main' | 'all-accounts' | 'account-details'>('main')
  // eslint-disable-next-line svelte/prefer-writable-derived
  let accountName = $state('')
  let showUpgradeTooltip = $state(false)
  let showExportTooltip = $state(false)
  let networkSettingsModalOpen = $state(false)
  let showDeleteModal = $state(false)
  let showDeletePasswordModal = $state(false)
  let deletePasswordError = $state<string | undefined>(undefined)
  let deletePasswordBusy = $state(false)
  let deleteError = $state<string | undefined>(undefined)
  let isDeleteAuthInProgress = $state(false)
  // Non-reactive flag set when the user cancels mid-auth. Checked before
  // performing deletion so a late-resolving auth promise can't override the
  // user's intent (e.g. reflexive biometric touch after clicking Cancel).
  let deleteCancelled = false

  $effect(() => {
    accountName = account.name
  })

  function selectAccount(acc: Account) {
    // Navigate to the clicked account, keeping the same sub-page where possible.
    const currentPath = page.url.pathname
    const target = currentPath.includes('/stamps')
      ? routes.ACCOUNT_STAMPS
      : currentPath.includes('/settings')
        ? routes.ACCOUNT_SETTINGS
        : routes.ACCOUNT_APPS
    goto(resolve(target, { id: acc.id.toHex() }))
  }

  function onAccountNameChange() {
    accountsStore.setAccountName(account.id, accountName)
  }

  async function performAccountDeletion() {
    // The account owns its apps + stamps, so removing it drops the whole tree.
    // Clear any local app secrets the proxy reads first.
    for (const app of account.connectedApps) {
      localStorage.removeItem(`${SWARM_SECRET_PREFIX}${app.appUrl}`)
    }
    accountsStore.removeAccount(account.id)
    sessionStore.clearAccount()
    showDeleteModal = false
    drawerOpen = false
    await goto(resolve(routes.HOME))
  }

  async function handleDeleteAccount() {
    deleteError = undefined
    deleteCancelled = false

    // Re-authenticate as a confirmation gate before the destructive delete (the
    // derived key itself is discarded). Password accounts have no interactive
    // ceremony, so collect the password in a modal and verify it there.
    if (account.access.type === 'password') {
      showDeleteModal = false
      deletePasswordError = undefined
      showDeletePasswordModal = true
      return
    }

    isDeleteAuthInProgress = true
    try {
      try {
        await getMasterKeyFromAccount(account)
      } catch (err) {
        deleteError = err instanceof Error ? err.message : 'Authentication failed'
        console.error('Authentication failed:', err)
        return
      }
      if (deleteCancelled) {
        // User dismissed the modal while auth was pending — honor that.
        return
      }
      await performAccountDeletion()
    } finally {
      isDeleteAuthInProgress = false
    }
  }

  async function handleDeletePasswordProvided(password: string) {
    deletePasswordBusy = true
    deletePasswordError = undefined
    try {
      await getMasterKeyFromAccount(account, password)
    } catch (err) {
      deletePasswordError = err instanceof Error ? err.message : 'Authentication failed'
      console.error('Authentication failed:', err)
      return
    } finally {
      deletePasswordBusy = false
    }
    showDeletePasswordModal = false
    await performAccountDeletion()
  }

  function handleDeletePasswordCancel() {
    showDeletePasswordModal = false
  }

  let showPasskeyExportWarning = $state(false)

  async function handleExportAccount() {
    let url: string | undefined
    try {
      const encrypted = await createEncryptedExport(
        account,
        await deriveSwarmEncryptionKey(account.derivationKey),
      )
      const json = JSON.stringify(encrypted, undefined, 2)
      const blob = new Blob([json], { type: 'application/json' })
      url = URL.createObjectURL(blob)
      const now = new Date()
      const date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-')
      const time = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')
      const a = document.createElement('a')
      a.href = url
      a.download = `${account.name}_${date}-${time}.swarmid`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)

      if (account.access.type === 'passkey') {
        showPasskeyExportWarning = true
      }
    } catch (err) {
      console.error('Export account failed:', err)
    } finally {
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
  }

  async function handleSignOut() {
    // Clear local app secrets, then drop the whole account (it owns its apps +
    // stamps).
    for (const app of account.connectedApps) {
      localStorage.removeItem(`${SWARM_SECRET_PREFIX}${app.appUrl}`)
    }
    accountsStore.removeAccount(account.id)
    sessionStore.clearAccount()
    drawerOpen = false
    await goto(resolve(routes.HOME))
  }
</script>

{#if drawerOpen}
  <button class="sidebar-backdrop" onclick={() => (drawerOpen = false)} aria-label="Close menu"
  ></button>
{/if}
<div class="sidebar-wrapper" class:open={drawerOpen}>
  <div class="sidebar">
    <Vertical --vertical-gap="0">
      {#if screen === 'main'}
        <Horizontal
          --horizontal-gap="var(--double-padding)"
          --horizontal-justify-content="space-between"
          --horizontal-align-items="center"
          style="padding: var(--padding)"
        >
          <Horizontal --horizontal-gap="var(--half-padding)">
            {account.access.type === 'eth-wallet'
              ? 'Ethereum'
              : account.access.type === 'passkey'
                ? 'Passkey'
                : 'Agent'}
            <Badge>{account.defaultPostageStampBatchID ? 'Synced' : 'Local'}</Badge>
          </Horizontal>
          <Button variant="ghost" dimension="compact" onclick={() => (drawerOpen = false)}
            ><CloseLarge size={20} /></Button
          >
        </Horizontal>

        <Vertical
          --vertical-gap="0"
          --vertical-align-items="stretch"
          style="padding: var(--padding)"
        >
          <Button variant="ghost" dimension="compact" onclick={() => (screen = 'account-details')}>
            <Horizontal
              --horizontal-gap="var(--half-padding)"
              --horizontal-align-items="center"
              --horizontal-justify-content="stretch"
              style="flex: 1"
            >
              Account details
              <FlexItem />
              <ChevronRight size={20} />
            </Horizontal></Button
          >
        </Vertical>
        <Divider --margin="0" />
        <Vertical
          --vertical-gap="0"
          --vertical-align-items="stretch"
          style="padding: var(--padding)"
        >
          <Button variant="ghost" dimension="compact" onclick={() => (screen = 'all-accounts')}>
            <Horizontal
              --horizontal-gap="var(--half-padding)"
              --horizontal-align-items="center"
              --horizontal-justify-content="stretch"
              style="flex: 1"
            >
              All accounts
              <FlexItem />
              <ChevronRight size={20} />
            </Horizontal></Button
          >
        </Vertical>
        <Divider --margin="0" />
        <Vertical
          --vertical-gap="0"
          --vertical-align-items="stretch"
          style="padding: var(--padding)"
        >
          <Button
            variant="ghost"
            dimension="compact"
            onclick={() => (networkSettingsModalOpen = true)}
          >
            <Horizontal
              --horizontal-gap="var(--half-padding)"
              --horizontal-align-items="center"
              --horizontal-justify-content="stretch"
              style="flex: 1"
            >
              <ContentDeliveryNetwork size={20} />
              Network settings
            </Horizontal></Button
          >
        </Vertical>
        <Divider --margin="0" />
        <Vertical
          --vertical-gap="0"
          --vertical-align-items="stretch"
          style="padding: var(--padding)"
        >
          <Horizontal
            --horizontal-gap="var(--half-padding)"
            --horizontal-align-items="center"
            --horizontal-justify-content="stretch"
            style="flex: 1;"
          >
            <Typography style="padding: var(--half-padding)">Appearance</Typography>
            <FlexItem />
            <ThemeToggle />
          </Horizontal>
        </Vertical>
      {:else if screen === 'all-accounts'}
        <Horizontal
          --horizontal-gap="var(--double-padding)"
          --horizontal-justify-content="space-between"
          --horizontal-align-items="center"
          style="padding: var(--padding)"
        >
          <Horizontal --horizontal-gap="var(--half-padding)">
            <Button variant="ghost" dimension="compact" onclick={() => (screen = 'main')}
              ><ChevronLeft size={20} /></Button
            >
            All accounts
          </Horizontal>
          <Button variant="ghost" dimension="compact" onclick={() => (drawerOpen = false)}
            ><CloseLarge size={20} /></Button
          >
        </Horizontal>
        <Vertical --vertical-gap="0" style="padding: var(--padding)">
          {#each accounts as acc (acc.id.toHex())}
            <Button variant="ghost" dimension="compact" onclick={() => selectAccount(acc)}>
              <Horizontal
                --horizontal-gap="var(--half-padding)"
                --horizontal-align-items="center"
                --horizontal-justify-content="stretch"
                style="flex: 1"
              >
                {#if acc.access.type === 'eth-wallet'}
                  <EthereumLogo size={20} />
                {:else if acc.access.type === 'passkey'}
                  <PasskeyLogo size={20} />
                {:else}
                  <Bot size={20} />
                {/if}
                {acc.name}
                <FlexItem />
                {#if account.id.equals(acc.id)}
                  <Checkmark size={20} />
                {/if}
              </Horizontal>
            </Button>
          {/each}
        </Vertical>
        <Divider --margin="0" />
        <Vertical
          --vertical-gap="0"
          --vertical-align-items="stretch"
          style="padding: var(--padding)"
        >
          <Button
            variant="ghost"
            dimension="compact"
            onclick={() => {
              drawerOpen = false
              goto(resolve(routes.ACCOUNT_NEW))
            }}
          >
            <Horizontal
              --horizontal-gap="var(--half-padding)"
              --horizontal-align-items="center"
              --horizontal-justify-content="stretch"
              style="flex: 1"
            >
              <Add size={20} />
              Add account
            </Horizontal></Button
          >
        </Vertical>
      {:else if screen === 'account-details'}
        <Horizontal
          --horizontal-gap="var(--double-padding)"
          --horizontal-justify-content="space-between"
          --horizontal-align-items="center"
          style="padding: var(--padding)"
        >
          <Horizontal --horizontal-gap="var(--half-padding)">
            <Button variant="ghost" dimension="compact" onclick={() => (screen = 'main')}
              ><ChevronLeft size={20} /></Button
            >
            Account details
          </Horizontal>
          <Button variant="ghost" dimension="compact" onclick={() => (drawerOpen = false)}
            ><CloseLarge size={20} /></Button
          >
        </Horizontal>
        <Vertical --vertical-gap="var(--padding)" style="padding: 0 var(--padding)">
          <Vertical --vertical-gap="var(--half-padding)">
            <Input
              variant="outline"
              dimension="compact"
              name="id-name"
              bind:value={accountName}
              class="grower"
              label="Account name"
              oninput={onAccountNameChange}
            />
            <Horizontal --horizontal-gap="var(--quarter-padding)">
              {#if account.access.type === 'eth-wallet'}
                <EthereumLogo size={20} />Ethereum
              {:else if account.access.type === 'passkey'}
                <PasskeyLogo size={20} />Passkey
              {:else}
                <Bot size={20} />Agent
              {/if}
            </Horizontal>
          </Vertical>
          <Vertical --vertical-gap="var(--quarter-padding)">
            <Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="end">
              <Input
                variant="outline"
                dimension="compact"
                value={account.id.toHex()}
                class="grower"
                label="Account address"
                disabled
              />
              <div style="border: 1px solid transparent">
                <CopyButton text={account.id.toHex()} />
              </div>
            </Horizontal>
            <Typography variant="small">Used to buy and own stamps</Typography>
          </Vertical>
          <Input
            variant="outline"
            dimension="compact"
            value={account.defaultPostageStampBatchID ? 'Synced' : 'Local'}
            class="grower"
            label="Account type"
            disabled
            helperText={account.defaultPostageStampBatchID
              ? 'Account is synced and can upload content.'
              : 'Limited to viewing only. Upgrade to synced account to upload content and sync across devices.'}
          />
        </Vertical>

        <Vertical
          --vertical-gap="0"
          --vertical-align-items="stretch"
          --vertical-justify-content="stretch"
          style="padding: var(--padding)"
        >
          {#if !account.defaultPostageStampBatchID}
            <Horizontal
              --horizontal-gap="var(--half-padding)"
              --horizontal-align-items="stretch"
              --horizontal-justify-content="stretch"
              class="grower"
            >
              <Button
                variant="ghost"
                dimension="compact"
                onclick={notImplemented}
                flexGrow
                leftAlign
              >
                <Rocket size={20} />
                Upgrade account
                <FlexItem />
              </Button>
              <Tooltip
                show={showUpgradeTooltip}
                position="top"
                variant="small"
                color="dark"
                maxWidth="279px"
              >
                <Button
                  variant="ghost"
                  dimension="small"
                  onmouseenter={() => (showUpgradeTooltip = true)}
                  onmouseleave={() => (showUpgradeTooltip = false)}
                  onclick={(e: MouseEvent) => {
                    e.stopPropagation()
                    showUpgradeTooltip = !showUpgradeTooltip
                  }}
                >
                  <Information size={16} />
                </Button>
                {#snippet helperText()}
                  Upgrading requires a Swarm postage stamp. You'll be able to upload content to
                  Swarm and access your account from any device.
                {/snippet}
              </Tooltip>
            </Horizontal>
          {/if}
          <Horizontal
            --horizontal-gap="var(--half-padding)"
            --horizontal-align-items="stretch"
            --horizontal-justify-content="stretch"
            class="grower"
          >
            <Button
              variant="ghost"
              dimension="compact"
              onclick={handleExportAccount}
              flexGrow
              leftAlign
            >
              <Export size={20} />
              Export account
              <FlexItem />
            </Button>
            <Tooltip
              show={showExportTooltip}
              position="top"
              variant="small"
              color="dark"
              maxWidth="279px"
            >
              <Button
                variant="ghost"
                dimension="small"
                onmouseenter={() => (showExportTooltip = true)}
                onmouseleave={() => (showExportTooltip = false)}
                onclick={(e: MouseEvent) => {
                  e.stopPropagation()
                  showExportTooltip = !showExportTooltip
                }}
              >
                <Information size={16} />
              </Button>
              {#snippet helperText()}
                {#if showPasskeyExportWarning}
                  Backup exported. Note: passkey-encrypted backups can only be imported on devices
                  where this passkey is available (synced via iCloud/Google, or the same hardware
                  key).
                {:else}
                  Save an encrypted backup of your Swarm ID account as a .swarmid file
                {/if}
              {/snippet}
            </Tooltip>
          </Horizontal>
          {#if account.defaultPostageStampBatchID}
            <Button variant="ghost" dimension="compact" leftAlign onclick={handleSignOut}>
              <Logout size={20} />
              Sign out
            </Button>
          {/if}
          <Button
            variant="ghost"
            dimension="compact"
            danger
            leftAlign
            onclick={() => {
              deleteError = undefined
              showDeleteModal = true
            }}
          >
            <TrashCan size={20} />
            Delete account
          </Button>
        </Vertical>
      {/if}
    </Vertical>
  </div>
</div>
<NetworkSettingsModal bind:open={networkSettingsModalOpen} />

<DeleteModal
  bind:open={showDeleteModal}
  title="Delete account?"
  text="This will permanently delete your account and all associated data. This action cannot be undone. You'll be asked to authenticate before the account is deleted."
  buttonTitle="Delete account"
  confirm={handleDeleteAccount}
  error={deleteError}
  disableCancel={isDeleteAuthInProgress}
  oncancel={() => {
    if (isDeleteAuthInProgress) {
      // Late cancel paths (Esc, click-outside) can still fire while auth is
      // pending; mark cancelled so the resolved auth doesn't trigger deletion.
      deleteCancelled = true
    }
    showDeleteModal = false
    deleteError = undefined
  }}
/>

<EnterPasswordModal
  bind:open={showDeletePasswordModal}
  title="Delete account?"
  description="Enter your account password to confirm deletion. This action cannot be undone."
  confirmLabel="Delete account"
  onSubmit={handleDeletePasswordProvided}
  onCancel={handleDeletePasswordCancel}
  error={deletePasswordError}
  busy={deletePasswordBusy}
/>

<style>
  .sidebar-backdrop {
    display: none;
  }

  .sidebar-wrapper {
    flex-shrink: 0;
    width: 375px;
    overflow: hidden;
    transition: width 0.25s ease-out;
    border-left: 1px solid var(--colors-low);
  }

  .sidebar-wrapper:not(.open) {
    width: 0;
    border-left: none;
  }

  .sidebar {
    width: 375px;
    height: 100vh;
    background: var(--colors-base);
    overflow-y: auto;
    transform: translateX(0);
    transition: transform 0.25s ease-out;
  }

  .sidebar-wrapper:not(.open) .sidebar {
    transform: translateX(100%);
  }

  /* Mobile: Full screen */
  @media screen and (max-width: 640px) {
    .sidebar-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
      border: none;
      cursor: pointer;
      opacity: 1;
      transition: opacity 0.25s ease-out;
    }

    .sidebar-wrapper {
      position: fixed;
      inset: 0;
      width: 100vw;
      z-index: 100;
      border-left: none;
    }

    .sidebar-wrapper:not(.open) {
      width: 100vw;
      pointer-events: none;
    }

    .sidebar {
      width: 100vw;
      height: 100vh;
    }
  }

  /* Respect reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .sidebar-wrapper,
    .sidebar {
      transition: none;
    }
  }
</style>
