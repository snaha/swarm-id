<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Sign-back-in ceremony for a signed-out account: unlock the retained vault
  with the existing security method, then restore the synced state — from the
  encrypted snapshot the sign-out kept, or (fallback) from Swarm. When neither
  has any data (`NoSyncedDataError`), the dialog swaps to an explicit warning
  instead of silently restoring an empty account; "Sign in anyway" retries
  with `allowEmpty`. Other restore errors (e.g. network unreachable) surface
  in the unlock dialog for a retry.
-->
<script lang="ts" module>
  import { formatYmd } from '$lib/drives'

  /** Unlock prompt for a check-storage sign-in, surfacing the expiry captured
   * at sign-out when there is one. */
  export function checkStorageDescription(account: { soonestDriveExpiry?: number }): string {
    const expiry = account.soonestDriveExpiry
    return expiry !== undefined
      ? `A drive may expire around ${formatYmd(expiry)}. Sign in to check your storage.`
      : 'Sign in to check your storage.'
  }
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import { NoSyncedDataError, signBackIn } from '$lib/sign-back-in'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    /** Overrides the standard unlock prompt (e.g. the check-storage flow). */
    description?: string
    /** Called with the restored live account and the entropy that unlocked it
     * (the connect flow completes the app handshake with it); the caller
     * unmounts the dialog. */
    onsignedin: (account: Account, entropy: Uint8Array) => void | Promise<void>
    onclose: () => void
  }

  let {
    account,
    description = 'Unlock with your security method to sign back in on this device.',
    onsignedin,
    onclose,
  }: Props = $props()

  /** Entropy stashed across the empty-account warning; zeroed on cancel. */
  let pendingEntropy = $state<Uint8Array | undefined>(undefined)

  async function onunlocked(entropy: Uint8Array) {
    try {
      const live = await signBackIn(account, entropy)
      await onsignedin(live, entropy)
    } catch (caught) {
      if (caught instanceof NoSyncedDataError) {
        // Not a retry-able unlock error: swap to the explicit warning below.
        pendingEntropy = entropy
        return
      }
      throw caught
    }
  }

  async function signInEmpty() {
    const entropy = pendingEntropy
    if (!entropy) {
      return
    }
    const live = await signBackIn(account, entropy, { allowEmpty: true })
    pendingEntropy = undefined
    await onsignedin(live, entropy)
  }

  function cancelEmpty() {
    pendingEntropy?.fill(0)
    pendingEntropy = undefined
    onclose()
  }
</script>

{#if pendingEntropy}
  <Dialog onclose={cancelEmpty} title="No synced data found">
    <p class="text-sm">
      No synced data was found for <span class="font-medium">{account.name}</span> — neither on this device
      nor on the Swarm network.
    </p>
    <p class="text-sm">
      You can sign in anyway, but the account will start empty: no drives and no app connections.
    </p>
    <div class="flex w-full flex-col gap-2">
      <Button variant="destructive" class="w-full" onclick={signInEmpty}>Sign in anyway</Button>
      <Button variant="outline" class="w-full" onclick={cancelEmpty}>Cancel</Button>
    </div>
  </Dialog>
{:else}
  <UnlockDialog {account} title="Sign in as {account.name}" {description} {onunlocked} {onclose} />
{/if}
