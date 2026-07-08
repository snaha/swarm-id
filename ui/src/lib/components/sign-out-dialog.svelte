<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Sign out a (synced) account on this device: wipes the seed vault, so the
  confirm is gated on the user acknowledging they can get back in with their
  Secret Recovery Phrase. The row stays in the account list ("Signed out").
-->
<script lang="ts">
  import LogOut from '@lucide/svelte/icons/log-out'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { sessionStore } from '$lib/stores/session.svelte'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    onClose: () => void
  }

  let { account, onClose }: Props = $props()

  let acknowledged = $state(false)

  function confirm() {
    // Capture once: the prop is a reactive getter, and callers derive it from
    // the session (a signed-out current account reads as "no session"), so
    // after signOut() the prop chain can already yield undefined.
    const target = account
    target.signOut()
    if (sessionStore.currentAccountId === target.id.toHex()) {
      sessionStore.clearCurrentAccount()
    }
    toastStore.show('Signed out')
    onClose()
  }
</script>

<Dialog onclose={onClose} title="Sign out">
  <p class="text-sm">
    This signs <span class="font-medium">{account.name}</span> out on this device and removes its security
    keys from it. Your account and its drives keep living on the Swarm network.
  </p>
  <p class="text-sm">
    To sign back in you will need your <span class="font-medium">Secret Recovery Phrase</span> and to
    set up a new security method.
  </p>
  <label class="flex cursor-pointer items-start gap-2 text-sm">
    <input type="checkbox" bind:checked={acknowledged} class="mt-0.5 cursor-pointer" />
    I have my Secret Recovery Phrase.
  </label>
  <div class="flex w-full flex-col gap-2">
    <Button variant="destructive" class="w-full" disabled={!acknowledged} onclick={confirm}>
      <LogOut />
      Sign out
    </Button>
    <Button variant="outline" class="w-full" onclick={onClose}>Cancel</Button>
  </div>
</Dialog>
