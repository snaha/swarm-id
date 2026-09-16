<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Bordered account rows for the chooser screens (connect popup, home chooser):
  avatar, name, truncated address, and a right-side slot. The slot shows the
  drive-attention action when the account has a drive expiring or full (and
  `oncheckdrive` is wired) — taking PRIORITY over any `badge` text, so
  "Signed out" and the drive warning never show together. The label names the
  drive and its state: inside the connect popup, next to rows reading "Signed
  out", anything worded about "storage" reads as a browser-storage permission
  step the user has to clear before connecting. The action is a real button
  and can't nest inside the row button, so each row is a relative wrapper with
  the select button underneath and the slot overlaid on the right.
-->
<script lang="ts">
  import AccountAvatar from '$lib/components/account-avatar.svelte'
  import AlertFill from '$lib/components/icons/alert-fill.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { type DriveAttention, accountDriveAttention, driveAttentionLabel } from '$lib/drives'
  import type { Account } from '$lib/types'
  import { truncateAddress } from '$lib/utils'

  interface Props {
    accounts: Account[]
    /** Badge text for a row (e.g. "Signed out"). */
    badge?: (account: Account) => string | undefined
    onselect: (account: Account) => void
    /** Enables the row action for a drive that is expiring or full. */
    oncheckdrive?: (account: Account, attention: DriveAttention) => void
  }

  let { accounts, badge, onselect, oncheckdrive }: Props = $props()
</script>

{#each accounts as account (account.id.toHex())}
  {@const attention = oncheckdrive === undefined ? undefined : accountDriveAttention(account)}
  {@const badgeText = attention ? undefined : badge?.(account)}
  <div class="relative">
    <button
      type="button"
      class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-lg border p-2 text-left outline-none {attention
        ? 'pr-32'
        : badgeText
          ? 'pr-24'
          : ''}"
      onclick={() => onselect(account)}
    >
      <AccountAvatar
        value={account.id.toHex()}
        size={36}
        class="shrink-0 overflow-hidden rounded-md"
      />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-medium">{account.name}</span>
        <span class="text-xs">
          {truncateAddress(account.id.toChecksum())}
        </span>
      </span>
    </button>
    {#if attention}
      <!-- Centering lives on the wrapper, NOT the button: the button's pressed
           state sets translate-y-px, which would REPLACE a -translate-y-1/2 on
           the element itself and lurch it out from under the pointer, eating
           the click. -->
      <span class="absolute inset-y-0 right-2 flex items-center">
        <Button
          variant="outline"
          size="sm"
          class="text-destructive"
          onclick={() => oncheckdrive?.(account, attention)}
        >
          <AlertFill />
          {driveAttentionLabel(attention)}
        </Button>
      </span>
    {:else if badgeText}
      <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center">
        <Badge>{badgeText}</Badge>
      </span>
    {/if}
  </div>
{/each}
