<script lang="ts">
  import Information from 'carbon-icons-svelte/lib/Information.svelte'
  import View from 'carbon-icons-svelte/lib/View.svelte'
  import ViewOff from 'carbon-icons-svelte/lib/ViewOff.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Input from '$lib/components/ui/input/input.svelte'
  import Tooltip from '$lib/components/ui/tooltip.svelte'

  let { value = $bindable() }: { value: string } = $props()

  let showPassword = $state(false)
  let showSeedTooltip = $state(false)
</script>

<div class="seed-input-row">
  <div class="seed-input">
    <Input
      variant="outline"
      dimension="compact"
      name="secret-seed"
      type={showPassword ? 'text' : 'password'}
      bind:value
    />
  </div>
  {#if value}
    <Button dimension="compact" variant="ghost" onclick={() => (showPassword = !showPassword)}>
      {#if showPassword}
        <ViewOff size={20} />
      {:else}
        <View size={20} />
      {/if}
    </Button>
  {:else}
    <Tooltip show={showSeedTooltip} position="bottom" variant="small" color="dark" maxWidth="279px">
      <Button
        dimension="compact"
        variant="ghost"
        onmouseenter={() => (showSeedTooltip = true)}
        onmouseleave={() => (showSeedTooltip = false)}
        onclick={(e: MouseEvent) => {
          e.stopPropagation()
          showSeedTooltip = !showSeedTooltip
        }}
      >
        <Information size={20} />
      </Button>
      {#snippet helperText()}
        The secret seed you set when creating your account. You were prompted to save this in a
        password manager or secure location.
      {/snippet}
    </Tooltip>
  {/if}
</div>

<style>
  .seed-input-row {
    display: flex;
    gap: var(--half-padding);
    align-items: center;
  }

  .seed-input {
    flex: 1;
    min-width: 0;
  }
</style>
