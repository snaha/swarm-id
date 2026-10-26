<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Delete an account everywhere. The user types the account's name and confirms
  with its own access method — proof of control; the decrypted seed is zeroed
  at once — then `deleteAccount` dilutes the drives they did not keep, tells the
  other devices, and removes the record. Mounted by the page rather than the
  Account tab: the tab goes the moment the record does, and the outcome still
  has to be shown.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte'

  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Info from '@lucide/svelte/icons/info'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  import { createAttemptTracker } from '$lib/attempt'
  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import PaymentDialog from '$lib/components/payment-dialog.svelte'
  import SecretRow from '$lib/components/secret-row.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import UtilizationBar from '$lib/components/utilization-bar.svelte'
  import { type DeletionProgress, deleteAccount } from '$lib/delete-account'
  import { appsUsingDrive, describeDrive } from '$lib/drives'
  import { createFundingRequester } from '$lib/payment/funding-request.svelte'
  import type { Account } from '$lib/types'
  import { cn, truncateAddress } from '$lib/utils'

  interface Props {
    account: Account
    onClose: () => void
  }

  let { account, onClose }: Props = $props()

  type Phase = 'form' | 'deleting' | 'success' | 'failure' | 'partial'

  // Fixed for the dialog's life, read once: the record changes under it as the
  // deletion runs (dilutions, the deletion marker) and is removed at the end.
  const access = untrack(() => account.accessMethod)
  const synced = untrack(() => !account.isLocal)

  let phase = $state<Phase>('form')
  let typedName = $state('')
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

  const drives = $derived(
    account.stamps.map((drive) => ({
      key: drive.batchID.toHex(),
      display: describeDrive(drive),
      isDefault: account.defaultPostageStampBatchID?.equals(drive.batchID) ?? false,
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

  function close() {
    attempts.supersede()
    funding.cancel()
    onClose()
  }

  // The dialog can unmount without close() — the same as closing it: abandon a
  // payment request nobody is left to answer, and supersede the attempt first,
  // or that abandoned payment reads as a decline and the teardown runs with
  // nobody left to hand the signer key to. One already with the wallet is not
  // abandoned by this.
  onDestroy(() => {
    attempts.supersede()
    funding.cancel()
  })

  function unlocked(entropy: Uint8Array) {
    // Deletion needs proof of control, not the seed itself.
    entropy.fill(0)
    void run()
  }

  async function run() {
    const attempt = attempts.begin()
    phase = 'deleting'
    progress = { step: 'checking' }
    try {
      // `checkpoint` is where a cancel lands: it throws `SupersededError` once
      // this attempt is stale, before the first spend and again before the
      // teardown. The dilutions between them are deliberately unguarded —
      // on-chain spends whose record updates must land even if the dialog was
      // closed — and so is the teardown once begun, which removes the account
      // only after its deletion is published. Only the UI epilogue is skipped.
      const result = await deleteAccount({
        account,
        keep: new Set(Object.keys(keep).filter((key) => keep[key])),
        requestFunding: funding.request,
        checkpoint: () => attempt.guard(Promise.resolve()),
        onProgress: (next) => (progress = next),
      })
      if (!attempt.current) {
        return
      }
      if (result.status === 'partial') {
        signerPrivateKey = result.signerPrivateKey
        phase = 'partial'
        return
      }
      phase = 'success'
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
{:else if phase === 'deleting'}
  <Dialog onclose={close} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm font-bold">Deleting account</p>
      <p class="text-muted-foreground text-sm">{progressLabel}</p>
    </div>
  </Dialog>
{:else if phase === 'success'}
  <Dialog onclose={onClose} title="Delete account">
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <CircleCheck class="size-6 text-green-600" />
      <p class="text-base font-medium">Account deleted</p>
      <p class="text-muted-foreground text-sm">Your account has been permanently deleted.</p>
    </div>
    <Button class="w-full" onclick={onClose}>Done</Button>
  </Dialog>
{:else if phase === 'failure'}
  <Dialog onclose={close} title="Delete account">
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <TriangleAlert class="text-destructive size-6" />
      <p class="text-base font-medium">Deletion failed</p>
      <p class="text-muted-foreground text-sm">
        Your account could not be deleted. Please try again.
      </p>
    </div>
    <Button class="w-full" onclick={run}>Retry</Button>
  </Dialog>
{:else if phase === 'partial' && signerPrivateKey}
  <Dialog onclose={onClose} title="Delete account">
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <Info class="text-muted-foreground size-6" />
      <p class="text-base font-medium">Some data couldn't be deleted</p>
      <p class="text-muted-foreground text-sm">
        Your account was deleted but some drives could not be removed due to insufficient funds on
        your account. Here is the private key to manage the postage batches directly.
      </p>
    </div>
    <SecretRow
      label="Private key"
      description="Used to manage postage batches directly"
      value={keyShown ? signerPrivateKey : undefined}
      copyValue={signerPrivateKey}
      onreveal={() => (keyShown = true)}
      onhide={() => (keyShown = false)}
    />
    <Button class="w-full" onclick={onClose}>OK</Button>
  </Dialog>
{:else}
  <UnlockDialog
    {account}
    title="Delete account"
    {confirmLabel}
    pendingTitle={access.type === 'eth-wallet'
      ? 'Confirm delete with wallet'
      : 'Confirm delete with passkey'}
    passwordLabel="Account password"
    canConfirm={typedName === account.name}
    destructive
    onunlocked={unlocked}
    onclose={close}
  >
    {#snippet header()}
      <div class="flex w-full items-center gap-3">
        <AccountAvatar value={account.id.toChecksum()} size={40} />
        <div class="flex min-w-0 flex-col">
          <p class="truncate text-sm font-medium">{account.name}</p>
          <p class="text-muted-foreground text-xs">{truncateAddress(account.id.toChecksum())}</p>
        </div>
      </div>
    {/snippet}

    <p class="text-sm">
      {synced
        ? 'This will permanently delete your account and all associated drives. Data stored by connected apps may be lost.'
        : 'This will permanently delete your account.'}
    </p>
    {#if synced}
      <!-- Peers that are offline now only learn of the deletion from the feed,
           and the feed lives on the default drive (docs/Account-State.md,
           "Offline devices"). -->
      <p class="text-muted-foreground text-sm">
        Your other devices learn of the deletion through your default drive. One that stays offline
        until that drive expires will keep the account. Unless you keep the drive's data, that is
        within about two days.
      </p>
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

    {#snippet footer()}
      {#if synced}
        <div class="flex w-full flex-col gap-2">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center justify-between text-sm font-medium"
            aria-expanded={manageOpen}
            onclick={() => (manageOpen = !manageOpen)}
          >
            Manage data
            <ChevronDown class={cn('size-4 transition-transform', manageOpen && 'rotate-180')} />
          </button>
          {#if manageOpen}
            <p class="text-muted-foreground text-sm">
              By default, all drives data is deleted with your account. Enable 'Keep data' on a
              drive to let its data remain on Swarm until the drive expires naturally.
            </p>
            {#each drives as { key, display, isDefault, usedBy } (key)}
              <div class="border-border flex w-full flex-col gap-2 rounded-lg border px-4 py-3">
                <div class="flex items-center gap-2">
                  <p class="truncate text-sm font-medium">{display.name}</p>
                  {#if isDefault}
                    <Badge>Default</Badge>
                  {/if}
                  <div class="flex flex-1 items-center justify-end gap-2">
                    <span class="text-sm whitespace-nowrap">Keep data</span>
                    <Switch
                      bind:checked={() => keep[key] ?? false, (value) => (keep[key] = value)}
                      aria-label="Keep data on {display.name}"
                    />
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  {#if display.storageFull}
                    <Badge variant="destructive">Storage full</Badge>
                  {:else}
                    <span class="text-sm whitespace-nowrap">{display.sizeLabel}</span>
                    {#if !display.scratch}
                      <UtilizationBar percent={display.usedPercent} />
                    {/if}
                  {/if}
                  {#if display.status === 'expired'}
                    <Badge variant="destructive">Expired</Badge>
                  {:else if display.status === 'expires-soon'}
                    <Badge variant="destructive">Expires soon</Badge>
                  {:else if display.timeLeftLabel}
                    <Badge variant="outline">{display.timeLeftLabel}</Badge>
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
    {/snippet}
  </UnlockDialog>
{/if}
