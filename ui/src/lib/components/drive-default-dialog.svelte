<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Confirm a change of the default drive (#958). The switch moves where the
  account syncs and where every app that follows the default writes next, and
  copies nothing: what is already saved stays on the old drive. So the user
  types a phrase rather than clicking once, and is told what stays behind.
  Moving the data with the switch is #365.
-->
<script lang="ts">
  import Star from '@lucide/svelte/icons/star'
  import type { PostageStamp } from '@snaha/swarm-id/internal'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { driveDisplayName } from '$lib/drives'
  import type { Account } from '$lib/types'

  /** What the user types to confirm; a fixed phrase, as drive names can be blank or long */
  const CONFIRM_PHRASE = 'change default'

  interface Props {
    account: Account
    drive: PostageStamp
    onClose: () => void
    onChanged?: (message: string) => void
  }

  let { account, drive, onClose, onChanged }: Props = $props()

  let typed = $state('')

  const current = $derived(
    account.stamps.find((stamp) => account.defaultPostageStampBatchID?.equals(stamp.batchID)),
  )
  // An app with no drive list, or full drive access, writes to whatever the
  // default is when it names no drive.
  const followers = $derived(
    account.activeApps.filter((app) => app.drives === undefined || app.drives === 'all'),
  )
  const confirmed = $derived(typed.trim().toLowerCase() === CONFIRM_PHRASE)

  function setDefault() {
    if (!confirmed) return
    account.setDefaultStamp(drive.batchID)
    onChanged?.('Default drive updated')
    onClose()
  }
</script>

<Dialog onclose={onClose} title="Change the default drive">
  <p class="text-sm">
    From now on, your account syncs to <span class="font-medium">{driveDisplayName(drive)}</span>,
    and so does every app below whenever it saves without picking a drive.
  </p>
  <div
    role="note"
    class="border-destructive/50 bg-destructive/10 flex flex-col gap-2 rounded-lg border p-3 text-sm"
  >
    <p class="font-medium">Nothing is copied to the new drive.</p>
    <p>
      Everything already saved stays on
      {#if current}
        <span class="font-medium">{driveDisplayName(current)}</span>.
      {:else}
        the current default drive.
      {/if}
      Apps that follow the default will start saving to the new drive and may not find what they saved
      before, which can look like missing files.
    </p>
    <p>
      Do not remove the old drive, or let it expire, while you still need what is on it: that data
      is lost with it.
    </p>
  </div>
  {#if followers.length > 0}
    <div class="flex flex-col gap-1 text-sm">
      <p class="font-medium">Apps that follow the default drive</p>
      <ul class="text-muted-foreground list-inside list-disc">
        {#each followers as app (app.appUrl)}
          <li class="truncate">{app.appName}</li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="flex flex-col gap-1">
    <label for="confirm-default-drive" class="text-sm">
      Type <code class="bg-muted rounded px-1 py-0.5 font-medium">{CONFIRM_PHRASE}</code> to confirm
    </label>
    <Input
      id="confirm-default-drive"
      bind:value={typed}
      autocomplete="off"
      spellcheck={false}
      data-autofocus
      onkeydown={(event) => {
        if (event.key === 'Enter') setDefault()
      }}
    />
  </div>
  <div class="flex w-full flex-col gap-2">
    <Button variant="destructive" class="w-full" disabled={!confirmed} onclick={setDefault}>
      <Star />
      Set as default
    </Button>
    <Button variant="outline" class="w-full" onclick={onClose}>Cancel</Button>
  </div>
</Dialog>
