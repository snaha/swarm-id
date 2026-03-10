<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import { layoutStore } from '$lib/stores/layout.svelte'

  interface Props {
    text: string
    buttonText: string
    onclick?: (e: Event) => void
  }

  let { text, buttonText, onclick }: Props = $props()
  let isHovered = $state(false)
</script>

<div
  class="card"
  role="button"
  tabindex="0"
  onmouseenter={() => (isHovered = true)}
  onmouseleave={() => (isHovered = false)}
  {onclick}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onclick?.(e)
    }
  }}
>
  {#if layoutStore.mobile}
    <Vertical --vertical-gap="var(--padding)">
      <Typography>{text}</Typography>
      <div class="full-width-button">
        <Button variant="secondary" dimension="compact" hover={isHovered}>{buttonText}</Button>
      </div>
    </Vertical>
  {:else}
    <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
      <Typography variant="small">{text}</Typography>
      <Button variant="secondary" dimension="small" hover={isHovered}>{buttonText}</Button>
    </Horizontal>
  {/if}
</div>

<style>
  .card {
    border-top: 1px solid var(--colors-low);
    padding: var(--padding);
    cursor: pointer;
  }

  .card:hover,
  .card:focus {
    background: var(--colors-base);
  }

  .card:hover :global(button),
  .card:focus :global(button) {
    background: transparent !important;
  }

  .full-width-button {
    display: flex;
  }

  .full-width-button :global(.root) {
    flex-grow: 1;
  }

  @media screen and (max-width: 640px) {
    .card {
      border-top: none;
    }
  }
</style>
