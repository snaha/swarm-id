<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Polycon from '$lib/components/polycon.svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import type { Account } from '$lib/types'
  import type { EthAddress } from '@ethersphere/bee-js'
  import FlexItem from './ui/flex-item.svelte'
  import { Checkmark } from 'carbon-icons-svelte'

  interface Props {
    accounts: Account[]
    currentAccountId?: EthAddress
    onAccountClick?: (account: Account) => void
    showBorder?: boolean
    showArrow?: boolean
  }

  let {
    accounts,
    currentAccountId,
    onAccountClick,
    showBorder = true,
    showArrow = true,
  }: Props = $props()

  let hoveredIndex = $state<number | undefined>(undefined)
  let focusedIndex = $state<number | undefined>(undefined)

  function handleAccountClick(account: Account) {
    if (currentAccountId && account.id.equals(currentAccountId)) return
    onAccountClick?.(account)
  }
</script>

<Vertical
  --vertical-gap="0"
  style={showBorder
    ? 'border: 1px solid var(--colors-low); gap: 1px; background-color: var(--colors-low);'
    : ''}
>
  {#each accounts as account, index (account.id.toHex())}
    <Button
      variant="ghost"
      dimension="compact"
      onclick={() => handleAccountClick(account)}
      class={showBorder ? 'account-button' : ''}
    >
      <Horizontal
        --horizontal-gap="var(--half-padding)"
        --horizontal-align-items="center"
        --horizontal-justify-content="stretch"
        style="flex: 1"
      >
        <Polycon value={account.id.toHex()} size={40} />
        <Vertical --vertical-gap="0" --vertical-align-items="start" style="flex: 1;">
          <Typography>{account.name}</Typography>
        </Vertical>
        <FlexItem />
        {#if currentAccountId && account.id.equals(currentAccountId)}
          <Checkmark size={20} />
        {:else if showArrow}
          <Button
            variant="ghost"
            dimension="compact"
            hover={hoveredIndex === index || focusedIndex === index}
          >
            <ArrowRight />
          </Button>
        {/if}
      </Horizontal>
    </Button>
  {/each}
</Vertical>

<style>
  :global(.account-button) {
    background-color: var(--colors-ultra-low);
  }
</style>
