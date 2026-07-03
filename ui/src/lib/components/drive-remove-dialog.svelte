<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import type { PostageStamp } from '@snaha/swarm-id'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
    onRemoved?: (message: string) => void
  }

  let { account, drive, onClose, onRemoved }: Props = $props()

  function remove() {
    account.removeStamp(drive.batchID)
    onRemoved?.('Drive removed')
    onClose()
  }
</script>

<Dialog onclose={onClose} title={drive.name || 'Drive'}>
  <p class="text-sm">
    This removes the drive from your account on all your devices. The storage itself stays on the
    Swarm network — this account can re-attach it later with its Batch ID.
  </p>
  <div class="flex w-full flex-col gap-2">
    <Button variant="destructive" class="w-full" onclick={remove}>
      <Trash2 />
      Remove drive
    </Button>
    <Button variant="outline" class="w-full" onclick={onClose}>Cancel</Button>
  </div>
</Dialog>
