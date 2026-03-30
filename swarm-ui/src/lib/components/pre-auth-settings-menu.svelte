<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import Dropdown from '$lib/components/ui/dropdown.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import type { Mode } from '$lib/components/ui/button.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import NetworkSettingsModal from './network-settings-modal.svelte'
  import ThemeToggle from './theme-toggle.svelte'
  import ContentDeliveryNetwork from 'carbon-icons-svelte/lib/ContentDeliveryNetwork.svelte'
  import Asleep from 'carbon-icons-svelte/lib/Asleep.svelte'

  interface Props {
    mode?: Mode
  }

  let { mode = 'auto' }: Props = $props()

  let networkSettingsModalOpen = $state(false)
</script>

<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="center">
  <Button
    variant="ghost"
    dimension="compact"
    {mode}
    onclick={() => {
      networkSettingsModalOpen = true
    }}
  >
    <ContentDeliveryNetwork size={20} />
    Network settings
  </Button>
  <Dropdown buttonVariant="ghost" buttonDimension="compact" {mode} left>
    {#snippet button()}
      <Asleep size={20} />
    {/snippet}
    <div class="popover">
      <Horizontal --horizontal-gap="var(--half-padding)">
        <Typography class="label">Appearance</Typography>
        <ThemeToggle />
      </Horizontal>
    </div>
  </Dropdown>
</Horizontal>

<NetworkSettingsModal bind:open={networkSettingsModalOpen} />

<style lang="postcss">
  .popover {
    background-color: var(--colors-ultra-low);
    border: 1px solid var(--colors-low);
    padding: var(--padding);
  }

  :global(.label) {
    color: var(--colors-high);
    min-width: 149px;
  }
</style>
