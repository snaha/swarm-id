<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Bordered account rows for the chooser screens (connect popup, home chooser):
  identicon, name, truncated address, and an optional badge.
-->
<script lang="ts">
  import Polycon from '$lib/components/polycon.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import type { Account } from '$lib/types'
  import { truncateAddress } from '$lib/utils'

  interface Props {
    accounts: Account[]
    /** Badge text for a row (e.g. "Signed out"). */
    badge?: (account: Account) => string | undefined
    onselect: (account: Account) => void
  }

  let { accounts, badge, onselect }: Props = $props()
</script>

{#each accounts as account (account.id.toHex())}
  {@const badgeText = badge?.(account)}
  <button
    type="button"
    class="hover:bg-muted focus-visible:bg-muted flex w-full cursor-pointer items-center gap-2 rounded-lg border p-2 text-left outline-none"
    onclick={() => onselect(account)}
  >
    <Polycon value={account.id.toHex()} size={36} class="shrink-0 overflow-hidden rounded-md" />
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-sm font-medium">{account.name}</span>
      <span class="text-xs">
        {truncateAddress(account.id.toChecksum())}
      </span>
    </span>
    {#if badgeText}
      <Badge>{badgeText}</Badge>
    {/if}
  </button>
{/each}
