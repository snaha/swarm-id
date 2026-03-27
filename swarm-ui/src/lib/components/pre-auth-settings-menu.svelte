<script lang="ts">
  import Dropdown from '$lib/components/ui/dropdown.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import type { Mode } from '$lib/components/ui/button.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import FlexItem from '$lib/components/ui/flex-item.svelte'
  import NetworkSettingsModal from './network-settings-modal.svelte'
  import ThemeToggle from './theme-toggle.svelte'
  import SettingsAdjust from 'carbon-icons-svelte/lib/SettingsAdjust.svelte'
  import ContentDeliveryNetwork from 'carbon-icons-svelte/lib/ContentDeliveryNetwork.svelte'

  interface Props {
    mode?: Mode
  }

  let { mode = 'auto' }: Props = $props()

  let networkSettingsModalOpen = $state(false)
  let dropdownOpen = $state(false)
</script>

<Dropdown
  buttonVariant="ghost"
  buttonDimension="compact"
  {mode}
  autoClose={false}
  bind:open={dropdownOpen}
>
  {#snippet button()}
    <SettingsAdjust size={20} />
  {/snippet}
  <div class="menu">
    <Vertical --vertical-gap="0" --vertical-align-items="stretch">
      <Button
        variant="ghost"
        dimension="compact"
        onclick={() => {
          networkSettingsModalOpen = true
          dropdownOpen = false
        }}
      >
        <Horizontal
          --horizontal-gap="var(--half-padding)"
          --horizontal-align-items="center"
          --horizontal-justify-content="stretch"
          style="flex: 1"
        >
          <ContentDeliveryNetwork size={20} />
          Network settings
        </Horizontal>
      </Button>
      <Horizontal
        --horizontal-gap="var(--half-padding)"
        --horizontal-align-items="center"
        --horizontal-justify-content="stretch"
        style="flex: 1; padding: var(--half-padding);"
      >
        <Typography style="padding: var(--half-padding)">Appearance</Typography>
        <FlexItem />
        <ThemeToggle />
      </Horizontal>
    </Vertical>
  </div>
</Dropdown>

<NetworkSettingsModal bind:open={networkSettingsModalOpen} />

<style lang="postcss">
  .menu {
    background-color: var(--colors-ultra-low);
    border: 1px solid var(--colors-low);
    padding: var(--half-padding);
    min-width: 220px;
  }
</style>
