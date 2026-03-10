<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    icon: Snippet
    title: string
    description: string
    buttonText: string
    buttonIcon?: Snippet
    onclick?: () => void
  }

  let { icon, title, description, buttonText, buttonIcon, onclick }: Props = $props()
  let isHovered = $state(false)
</script>

<div
  class="card"
  role="button"
  tabindex="-1"
  onmouseenter={() => (isHovered = true)}
  onmouseleave={() => (isHovered = false)}
  {onclick}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onclick?.()
    }
  }}
>
  <div class="card-header">
    <div class="icon">
      {@render icon()}
    </div>
    <Vertical --vertical-gap="var(--quarter-padding)" class="card-text">
      <Typography variant="h5">{title}</Typography>
      <Typography variant="small">
        {description}
      </Typography>
    </Vertical>
  </div>
  <div class="card-action">
    <Button variant="strong" dimension="compact" hover={isHovered}>
      {#if buttonIcon}
        {@render buttonIcon()}
      {/if}
      {buttonText}
    </Button>
  </div>
</div>

<style>
  .card {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--padding);
    gap: var(--padding);
    cursor: pointer;
  }

  .card:hover,
  .card:focus {
    background: var(--colors-base);
  }

  .card-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--padding);
  }

  :global(.card-text) {
    align-items: center;
    text-align: center;
  }

  .icon {
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .card-action {
    display: flex;
  }

  @media screen and (max-width: 640px) {
    .card {
      align-items: stretch;
    }

    .card-header {
      flex-direction: row;
      align-items: center;
      width: 100%;
    }

    :global(.card-text) {
      align-items: flex-start;
      text-align: left;
      flex: 1;
    }

    .card-action {
      width: 100%;
    }

    .card-action :global(.root) {
      flex-grow: 1;
    }
  }
</style>
