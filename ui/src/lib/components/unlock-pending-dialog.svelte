<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!-- The waiting state of a passkey / wallet unlock (`createUnlockCeremony`). -->
<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import type { UnlockCeremony } from '$lib/unlock-ceremony.svelte'

  interface Props {
    ceremony: UnlockCeremony
    /** Overrides the access-method-derived heading. */
    title?: string
    oncancel: () => void
  }

  let { ceremony, title, oncancel }: Props = $props()

  const wallet = $derived(ceremony.access.type === 'eth-wallet')
</script>

<Dialog onclose={oncancel} dismissable={false}>
  <div class="flex flex-col items-center gap-2 py-4 text-center">
    <LoaderCircle class="size-5 animate-spin" />
    <p class="text-sm font-bold">
      {title ?? (wallet ? 'Confirm with wallet' : 'Confirm with passkey')}
    </p>
    <p class="text-sm">
      {wallet
        ? 'Approve the request in your Ethereum wallet.'
        : 'Follow the prompts on your device.'}
    </p>
  </div>
  <Button variant="outline" class="w-full" onclick={oncancel}>Cancel</Button>
</Dialog>
