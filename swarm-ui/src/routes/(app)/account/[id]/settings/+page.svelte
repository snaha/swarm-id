<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import ResponsiveLayout from '$lib/components/ui/responsive-layout.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import { layoutStore } from '$lib/stores/layout.svelte'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import { page } from '$app/state'
  import { EthAddress } from '@ethersphere/bee-js'
  import Polycon from '$lib/components/polycon.svelte'
  import CopyButton from '$lib/components/copy-button.svelte'

  const account = $derived(
    page.params.id ? accountsStore.getAccount(new EthAddress(page.params.id)) : undefined,
  )

  // eslint-disable-next-line svelte/prefer-writable-derived
  let accountName = $state('')

  $effect(() => {
    accountName = account?.name ?? ''
  })

  function onNameChange() {
    if (account) {
      accountsStore.setAccountName(account.id, accountName)
    }
  }
</script>

<Vertical --vertical-gap="var(--double-padding)" style="padding-top: var(--double-padding);">
  <Vertical --vertical-gap="var(--padding)">
    <ResponsiveLayout
      --responsive-align-items="start"
      --responsive-justify-content="stretch"
      --responsive-gap="var(--quarter-padding)"
    >
      <Typography class={!layoutStore.mobile ? 'flex50 input-layout' : ''}>Account name</Typography>
      <Vertical
        class={!layoutStore.mobile ? 'flex50' : ''}
        --vertical-gap="var(--quarter-gap)"
        --vertical-align-items={layoutStore.mobile ? 'stretch' : 'start'}
      >
        <Horizontal --horizontal-gap="var(--half-padding)">
          <Input
            variant="outline"
            dimension="compact"
            name="account-name"
            bind:value={accountName}
            class="grower"
            oninput={onNameChange}
          />
          {#if account}
            <Polycon value={account.id.toHex()} size={40} />
          {/if}
        </Horizontal>
      </Vertical>
    </ResponsiveLayout>

    <ResponsiveLayout
      --responsive-align-items="start"
      --responsive-justify-content="stretch"
      --responsive-gap="var(--quarter-padding)"
    >
      <Typography class={!layoutStore.mobile ? 'flex50 input-layout' : ''}
        >Account address</Typography
      >
      <Vertical
        class={!layoutStore.mobile ? 'flex50' : ''}
        --vertical-gap="var(--quarter-gap)"
        --vertical-align-items={layoutStore.mobile ? 'stretch' : 'start'}
      >
        <Horizontal --horizontal-gap="var(--half-padding)">
          <Input
            variant="outline"
            dimension="compact"
            name="account-address"
            value={account?.id.toHex()}
            class="grower"
            disabled
          />
          {#if account}
            <CopyButton text={account.id.toHex()} />
          {/if}
        </Horizontal>
        <Typography variant="small">The address apps connect to and that owns stamps</Typography>
      </Vertical>
    </ResponsiveLayout>
  </Vertical>
</Vertical>

<style>
  :global(.flex50) {
    flex: 0.5;
  }
  :global(.input-layout) {
    padding: var(--half-padding) 0 !important;
    border: 1px solid transparent;
  }
</style>
