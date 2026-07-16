<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Sign-back-in ceremony for a signed-out account: unlock the retained vault
  with the existing security method, then restore the synced state from Swarm
  (`signBackIn`). A thrown restore error (e.g. network unreachable) shows in
  the unlock dialog for a retry.
-->
<script lang="ts">
  import UnlockDialog from '$lib/components/unlock-dialog.svelte'
  import { signBackIn } from '$lib/sign-back-in'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    /** Called with the restored live account; the caller unmounts the dialog. */
    onsignedin: (account: Account) => void | Promise<void>
    onclose: () => void
  }

  let { account, onsignedin, onclose }: Props = $props()

  async function onunlocked(entropy: Uint8Array) {
    const live = await signBackIn(account, entropy)
    await onsignedin(live)
  }
</script>

<UnlockDialog
  {account}
  title="Sign in as {account.name}"
  description="Unlock with your security method to sign back in on this device."
  {onunlocked}
  {onclose}
/>
