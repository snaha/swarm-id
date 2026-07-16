<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Bordered account rows for the chooser screens (connect popup, home chooser):
  identicon, name, truncated address, and a right-side slot. The slot shows the
  "Check storage" action when the account has drives needing attention (and
  `oncheckstorage` is wired) — taking PRIORITY over any `badge` text, so
  "Signed out" and the storage warning never show together. The action is a
  real button and can't nest inside the row button, so each row is a relative
  wrapper with the select button underneath and the slot overlaid on the right.
-->
<script lang="ts">
  import AlertFill from '$lib/components/icons/alert-fill.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { drivesNeedingAttention } from '$lib/drives'
  import type { Account } from '$lib/types'
  import { truncateAddress } from '$lib/utils'

  interface Props {
    accounts: Account[]
    /** Badge text for a row (e.g. "Signed out"). */
    badge?: (account: Account) => string | undefined
    onselect: (account: Account) => void
    /** Enables the "Check storage" row action for drives needing attention. */
    oncheckstorage?: (account: Account) => void
  }

  let { accounts, badge, onselect, oncheckstorage }: Props = $props()
</script>

{#each accounts as account (account.id.toHex())}
  {@const storageWarning = oncheckstorage !== undefined && drivesNeedingAttention(account) > 0}
  {@const badgeText = storageWarning ? undefined : badge?.(account)}
  <div class="relative">
    <button
      type="button"
      class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-lg border p-2 text-left outline-none {storageWarning
        ? 'pr-32'
        : badgeText
          ? 'pr-24'
          : ''}"
      onclick={() => onselect(account)}
    >
      <Polycon value={account.id.toHex()} size={36} class="shrink-0 overflow-hidden rounded-md" />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-medium">{account.name}</span>
        <span class="text-xs">
          {truncateAddress(account.id.toChecksum())}
        </span>
      </span>
    </button>
    {#if storageWarning}
      <!-- Centering lives on the wrapper, NOT the button: the button's pressed
           state sets translate-y-px, which would REPLACE a -translate-y-1/2 on
           the element itself and lurch it out from under the pointer, eating
           the click. -->
      <span class="absolute inset-y-0 right-2 flex items-center">
        <Button
          variant="outline"
          size="sm"
          class="text-destructive"
          onclick={() => oncheckstorage?.(account)}
        >
          <AlertFill />
          Check storage
        </Button>
      </span>
    {:else if badgeText}
      <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center">
        <Badge>{badgeText}</Badge>
      </span>
    {/if}
  </div>
{/each}
