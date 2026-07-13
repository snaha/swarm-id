<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Delete an account from THIS device. Unlike sign-out (which keeps a tombstone
  row and can be reversed with the recovery phrase), delete hard-removes the
  record via `accountsStore.remove`. Because it is destructive and irreversible
  for a local account, it is gated on the account's own access method: the user
  must re-confirm with their passkey, wallet, or password before the record is
  dropped. The decrypted seed is proof-of-control only and is zeroed
  immediately.
-->
<script lang="ts">
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    onClose: () => void
  }

  let { account, onClose }: Props = $props()

  // The Account tab only renders for the signed-in current account, so the
  // access method is always present (`accessMethod` asserts it).
  const access = $derived(account.accessMethod)

  const confirmLabel = $derived(
    access.type === 'passkey'
      ? 'Confirm delete with passkey'
      : access.type === 'eth-wallet'
        ? 'Confirm delete with ETH wallet'
        : 'Confirm delete with password',
  )

  function deleteAccount(seed: Uint8Array) {
    // Deletion needs proof-of-control, not the seed itself.
    seed.fill(0)
    const target = account
    accountsStore.remove(target.id)
    if (sessionStore.currentAccountId === target.id.toHex()) {
      sessionStore.clearCurrentAccount()
    }
    toastStore.show('Account deleted')
    onClose()
  }
</script>

<UnlockDialog
  {account}
  title="Delete account"
  {confirmLabel}
  destructive
  onunlocked={deleteAccount}
  onclose={onClose}
>
  <p class="text-sm">
    This permanently deletes <span class="font-medium">{account.name}</span> from this device. Your account
    and its data may not be recoverable.
  </p>
</UnlockDialog>
