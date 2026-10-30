<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Delete an account everywhere. The user types the account's name and confirms
  with its own access method — proof of control; the decrypted seed is zeroed
  at once — then `deleteAccount` does the rest. Mounted by the page rather
  than the Account tab, which goes the moment the record does.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte'

  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Info from '@lucide/svelte/icons/info'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  import { createAttemptTracker } from '$lib/attempt'
  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import PasswordInput from '$lib/components/password-input.svelte'
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
  import SecretRow from '$lib/components/secret-row.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import UnlockPendingDialog from '$lib/components/unlock-pending-dialog.svelte'
  import UtilizationBar from '$lib/components/utilization-bar.svelte'
  import { type DeletionProgress, canPublishToSwarm, deleteAccount } from '$lib/delete-account'
  import { appsUsingDrive, describeDrive } from '$lib/drives'
  import { createFundingRequester } from '$lib/payment/funding-request.svelte'
  import type { Account } from '$lib/types'
  import { createUnlockCeremony } from '$lib/unlock-ceremony.svelte'
  import { truncateAddress } from '$lib/utils'

  interface Props {
    account: Account
    onClose: () => void
  }

  let { account, onClose }: Props = $props()

  type Phase = 'form' | 'deleting' | 'unfunded' | 'success' | 'failure' | 'partial'

  /** Dots standing in for the handed-over key, as the design draws it. */
  const KEY_MASK_LENGTH = 8

  // Read once: the record changes under the dialog as the deletion runs, and
  // is removed at the end.
  const synced = untrack(() => !account.isLocal)
  const publishes = untrack(() => canPublishToSwarm(account))
  const defaultKey = untrack(() => account.defaultPostageStampBatchID?.toHex())

  const ceremony = untrack(() =>
    createUnlockCeremony(account, (entropy) => {
      // Deletion needs proof of control, not the seed itself.
      entropy.fill(0)
      password = ''
      void run()
    }),
  )
  const access = ceremony.access

  let phase = $state<Phase>('form')
  let typedName = $state('')
  let password = $state('')
  let manageOpen = $state(false)
  /** Batch id (hex) → the user turned "Keep data" on. */
  let keep = $state<Record<string, boolean>>({})
  let progress = $state<DeletionProgress>({ step: 'checking' })
  let signerPrivateKey = $state<string | undefined>(undefined)
  let keyShown = $state(false)
  const attempts = createAttemptTracker()
  const funding = createFundingRequester(() => account)

  const confirmLabel =
    access.type === 'passkey'
      ? 'Confirm delete with passkey'
      : access.type === 'eth-wallet'
        ? 'Confirm delete with ETH wallet'
        : 'Delete my account'

  const confirmable = $derived(
    typedName === account.name && (access.type !== 'password' || password.length > 0),
  )

  const offlineNote = $derived(
    !publishes
      ? 'Your devices that are offline now will keep the account.'
      : defaultKey && keep[defaultKey]
        ? 'A device that stays offline until your default drive expires may keep the account.'
        : 'A device that stays offline for more than about two days may keep the account.',
  )

  const drives = $derived(
    account.stamps.map((drive) => ({
      key: drive.batchID.toHex(),
      display: describeDrive(drive),
      isDefault: drive.batchID.toHex() === defaultKey,
      usedBy: appsUsingDrive(drive, account.connectedApps, account),
    })),
  )

  const progressLabel = $derived.by(() => {
    switch (progress.step) {
      case 'checking':
        return 'Checking your drives on chain…'
      case 'funding':
        return 'Waiting for the payment…'
      case 'diluting':
        return `Shortening drive ${progress.index + 1} of ${progress.total}…`
      default:
        return 'Telling your other devices…'
    }
  })

  function confirm() {
    if (confirmable) void ceremony.confirm(password)
  }

  function close() {
    ceremony.cancel()
    attempts.supersede()
    funding.cancel()
    onClose()
  }

  // Unmounting is closing: supersede first, or the abandoned payment would
  // read as a decline.
  onDestroy(() => {
    ceremony.cancel()
    attempts.supersede()
    funding.cancel()
  })

  async function run(undiluted = false) {
    const attempt = attempts.begin()
    phase = 'deleting'
    progress = { step: 'checking' }
    try {
      // `checkpoint` is where a cancel lands, before the first spend and the
      // teardown; the spends and the teardown themselves run to completion.
      const result = await deleteAccount({
        account,
        keep: new Set(Object.keys(keep).filter((key) => keep[key])),
        requestFunding: funding.request,
        undiluted,
        checkpoint: () => attempt.guard(Promise.resolve()),
        onProgress: (next) => (progress = next),
      })
      if (!attempt.current) {
        return
      }
      if (result.status === 'unfunded') {
        phase = 'unfunded'
      } else if (result.status === 'partial') {
        signerPrivateKey = result.signerPrivateKey
        phase = 'partial'
      } else {
        phase = 'success'
      }
    } catch (caught) {
      if (!attempt.current) {
        return
      }
      console.error('[DeleteAccount] Deletion failed:', caught)
      phase = 'failure'
    }
  }
</script>

{#if funding.pending}
  <PaymentDialog
    need={funding.pending.need}
    rail={funding.pending.rail}
    onPaid={funding.resolve}
    onCancel={funding.cancel}
  />
{:else if ceremony.pending}
  <UnlockPendingDialog
    {ceremony}
    title={access.type === 'eth-wallet'
      ? 'Confirm delete with wallet'
      : 'Confirm delete with passkey'}
    oncancel={close}
  />
{:else if phase === 'deleting'}
  <Dialog onclose={close} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm font-bold">Deleting account</p>
      <p class="text-muted-foreground text-sm">{progressLabel}</p>
    </div>
  </Dialog>
{:else if phase === 'unfunded'}
  <Dialog onclose={close} label="Drives can't be shortened">
    <div class="flex flex-col items-center gap-2 text-center">
      <TriangleAlert class="fill-destructive size-6 text-white" />
      <div class="text-sm">
        <p class="font-bold">Drives can't be shortened</p>
        <p>
          Shortening your drives so they expire needs a small gas payment, which wasn't made. You
          can delete the account anyway: its drives keep their data until they run out, and you get
          the key that manages them.
        </p>
      </div>
    </div>
    <Button variant="destructive" class="w-full" onclick={() => run(true)}>Delete anyway</Button>
    <Button variant="outline" class="w-full" onclick={() => (phase = 'form')}>Back</Button>
  </Dialog>
{:else if phase === 'success'}
  <Dialog onclose={onClose} label="Account deleted">
    <div class="flex flex-col items-center gap-2 text-center">
      <CircleCheck class="size-6 fill-green-600 text-white" />
      <div class="text-sm">
        <p class="font-bold">Account deleted</p>
        <p>Your account has been permanently deleted.</p>
      </div>
    </div>
    <Button class="w-full" onclick={onClose}>Done</Button>
  </Dialog>
{:else if phase === 'failure'}
  <Dialog onclose={close} label="Deletion failed">
    <div class="flex flex-col items-center gap-2 text-center">
      <TriangleAlert class="fill-destructive size-6 text-white" />
      <div class="text-sm">
        <p class="font-bold">Deletion failed</p>
        <p>Your account could not be deleted. Please try again.</p>
      </div>
    </div>
    <Button class="w-full" onclick={() => run()}>Retry</Button>
  </Dialog>
{:else if phase === 'partial' && signerPrivateKey}
  <Dialog onclose={onClose} label="Some data couldn't be deleted">
    <div class="flex flex-col items-center gap-2 text-center">
      <Info class="fill-foreground text-background size-6" />
      <div class="text-sm">
        <p class="font-bold">Some data couldn't be deleted</p>
        <p>
          Your account was deleted, but its drives were not shortened. Here is the private key to
          manage the postage batches directly.
        </p>
      </div>
    </div>
    <SecretRow
      label="Private key"
      description="Used to manage postage batches directly"
      value={keyShown ? signerPrivateKey : undefined}
      copyValue={signerPrivateKey}
      onreveal={() => (keyShown = true)}
      onhide={() => (keyShown = false)}
      maskLength={KEY_MASK_LENGTH}
    />
    <Button class="w-full" onclick={onClose}>OK</Button>
  </Dialog>
{:else}
  <Dialog onclose={close} title="Delete account" class="w-[36rem]">
    <div class="flex w-full items-center gap-3">
      <AccountAvatar value={account.id.toChecksum()} size={40} />
      <div class="flex min-w-0 flex-col">
        <p class="truncate text-sm font-medium">{account.name}</p>
        <p class="text-muted-foreground text-xs">{truncateAddress(account.id.toChecksum())}</p>
      </div>
    </div>

    <p class="text-sm">
      {synced
        ? "This will permanently delete your account and every drive you don't keep. Data stored by connected apps may be lost."
        : 'This will permanently delete your account.'}
    </p>
    {#if synced}
      <p class="text-muted-foreground text-sm">{offlineNote}</p>
    {/if}

    <div class="flex w-full flex-col gap-2">
      <label for="delete-account-name" class="text-sm">
        Type <span class="font-bold">{account.name}</span> to confirm:
      </label>
      <Input
        id="delete-account-name"
        bind:value={typedName}
        placeholder="Account name"
        autocomplete="off"
        data-autofocus
      />
    </div>

    {#if access.type === 'password'}
      <div class="flex w-full flex-col gap-2">
        <label for="delete-account-password" class="text-sm font-medium">Account password</label>
        <PasswordInput
          id="delete-account-password"
          bind:value={password}
          placeholder="Account password"
          autocomplete="current-password"
          onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && confirm()}
        />
      </div>
    {/if}

    {#if synced}
      <div class="flex w-full flex-col gap-2">
        <button
          type="button"
          class="flex w-full cursor-pointer items-center justify-between px-2 text-sm font-medium"
          aria-expanded={manageOpen}
          onclick={() => (manageOpen = !manageOpen)}
        >
          Manage data
          {#if manageOpen}
            <ChevronDown class="size-4" />
          {:else}
            <ChevronRight class="size-4" />
          {/if}
        </button>
        {#if manageOpen}
          <p class="text-muted-foreground px-2 text-xs">
            By default, all drives data is deleted with your account. Enable 'Keep data' on a drive
            to let its data remain on Swarm until the drive expires naturally.
          </p>
          {#each drives as { key, display, isDefault, usedBy } (key)}
            <div class="border-border flex w-full flex-col gap-2 rounded-lg border px-4 py-3">
              <div class="flex items-center gap-2">
                <p class="truncate text-sm font-medium">{display.name}</p>
                {#if isDefault}
                  <Badge variant="outline">Default</Badge>
                {/if}
                <div class="flex flex-1 items-center justify-end gap-2">
                  <Switch
                    bind:checked={() => keep[key] ?? false, (value) => (keep[key] = value)}
                    aria-label="Keep data on {display.name}"
                  />
                  <span class="text-sm whitespace-nowrap">Keep data</span>
                </div>
              </div>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  {#if display.storageFull}
                    <Badge variant="destructive">Storage full</Badge>
                  {:else}
                    <span class="text-xs whitespace-nowrap">{display.sizeLabel}</span>
                    {#if !display.scratch}
                      <UtilizationBar percent={display.usedPercent} />
                    {/if}
                  {/if}
                </div>
                {#if display.status === 'expired'}
                  <Badge variant="destructive">Expired</Badge>
                {:else if display.status === 'expires-soon'}
                  <Badge variant="destructive">Expires soon</Badge>
                {:else if display.timeLeftLabel}
                  <Badge>{display.timeLeftLabel}</Badge>
                {/if}
              </div>
              <p class="text-muted-foreground text-xs">
                Used by: {usedBy.length > 0 ? usedBy.join(', ') : 'no apps'}
              </p>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    {#if ceremony.error}
      <p class="text-destructive text-xs">{ceremony.error}</p>
    {/if}

    <Button
      variant="destructive"
      class="w-full"
      disabled={ceremony.busy || !confirmable}
      onclick={confirm}
    >
      {#if ceremony.busy}
        <LoaderCircle class="animate-spin" />
      {/if}
      {confirmLabel}
    </Button>
  </Dialog>
{/if}
