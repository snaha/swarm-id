<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Sign out a (synced) account on this device: strips the plaintext account
  data but keeps the encrypted vault plus an encrypted snapshot of the synced
  state, so signing back in only takes the security method and restores the
  state losslessly — no phrase acknowledgment needed. The row stays in the
  list ("Signed out").
-->
<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import LogOut from '@lucide/svelte/icons/log-out'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { encryptSignOutSnapshot } from '$lib/sign-out-snapshot'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    onClose: () => void
  }

  let { account, onClose }: Props = $props()

  let busy = $state(false)

  async function confirm() {
    if (busy) {
      return
    }
    busy = true
    try {
      // Capture once: the prop is a reactive getter, and callers derive it from
      // the session (a signed-out current account reads as "no session"), so
      // after signOut() the prop chain can already yield undefined.
      const target = account
      // Snapshot the synced state BEFORE the sign-out strips it — this is what
      // sign-back-in restores, so a sign-out can never lose data.
      const encryptedState = await encryptSignOutSnapshot(target)
      target.signOut(encryptedState)
      if (sessionStore.currentAccountId === target.id.toHex()) {
        sessionStore.clearCurrentAccount()
      }
      toastStore.show('Signed out')
      onClose()
    } finally {
      busy = false
    }
  }
</script>

<Dialog onclose={onClose} title="Sign out">
  <p class="text-sm">
    This signs <span class="font-medium">{account.name}</span> out on this device and removes its account
    data from it. Your account and its drives keep living on the Swarm network.
  </p>
  <p class="text-sm">
    To sign back in, unlock with your security method. If you ever lose it, your
    <span class="font-medium">Secret Recovery Phrase</span> is the only way back in.
  </p>
  <div class="flex w-full flex-col gap-2">
    <Button variant="destructive" class="w-full" disabled={busy} onclick={confirm}>
      {#if busy}
        <LoaderCircle class="animate-spin" />
      {:else}
        <LogOut />
      {/if}
      Sign out
    </Button>
    <Button variant="outline" class="w-full" onclick={onClose}>Cancel</Button>
  </div>
</Dialog>
