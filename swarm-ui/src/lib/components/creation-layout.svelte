<script lang="ts">
  import Typography from '$lib/components/ui/typography.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import ArrowLeft from 'carbon-icons-svelte/lib/ArrowLeft.svelte'
  import { CloseLarge } from 'carbon-icons-svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    description?: string
    onBack?: () => void
    onClose?: () => void
    content: Snippet
    buttonContent: Snippet
  }

  let { title, description, onBack, onClose, content, buttonContent }: Props = $props()
</script>

<div class="creation-layout">
  <!-- Header -->
  <div class="creation-header">
    <Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
      {#if onBack}
        <Horizontal --horizontal-gap="var(--half-padding)">
          <Button dimension="compact" variant="ghost" onclick={onBack}><ArrowLeft /></Button>
          <Typography variant="h4">{title}</Typography>
        </Horizontal>
      {:else}
        <Typography variant="h4">{title}</Typography>
      {/if}
      {#if onClose}
        <Button dimension="compact" variant="ghost" onclick={onClose}
          ><CloseLarge size={20} /></Button
        >
      {/if}
    </Horizontal>
    {#if description}
      <Typography class="description">{description}</Typography>
    {/if}
  </div>

  <!-- Content (grows and centers on mobile) -->
  <div class="creation-content">
    {@render content()}
  </div>

  <!-- Button -->
  <div class="creation-button">
    {@render buttonContent()}
  </div>
</div>

<style>
  .creation-layout {
    display: flex;
    flex-direction: column;
    gap: var(--double-padding);
    height: 100%;
  }

  .creation-header :global(.description) {
    color: var(--colors-ultra-high-50);
  }

  .creation-content {
    display: flex;
    flex-direction: column;
  }

  .creation-button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--half-padding);
  }

  @media screen and (max-width: 640px) {
    .creation-content {
      flex: 1;
      justify-content: center;
    }

    .creation-button {
      align-items: stretch;
    }
  }
</style>
