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
    fullPage?: boolean
    busy?: boolean
  }

  let {
    title,
    description,
    onBack,
    onClose,
    content,
    buttonContent,
    fullPage = false,
    busy = false,
  }: Props = $props()
</script>

{#snippet layoutContent()}
  <div class="creation-layout">
    <!-- Header -->
    {#if !busy}
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
    {/if}

    <!-- Content (grows and centers on mobile) -->
    <div class="creation-content">
      {@render content()}
    </div>

    <!-- Button -->
    <div class="creation-button">
      {@render buttonContent()}
    </div>
  </div>
{/snippet}

{#if fullPage}
  <div class="page-wrapper">
    <div class="page-content">
      <div class="content-area">
        {@render layoutContent()}
      </div>
    </div>
  </div>
{:else}
  {@render layoutContent()}
{/if}

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

  /* Full-page wrapper styles */
  .page-wrapper {
    display: flex;
    flex-direction: row;
    min-height: 100vh;
    background: var(--colors-ultra-low);
    position: relative;
    align-items: stretch;
    justify-content: space-around;
  }

  .page-content {
    flex: 1;
    display: flex;
    justify-content: center;
    flex-direction: column;
    align-items: center;
    padding: var(--double-padding);
  }

  .content-area {
    max-width: 560px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    width: 100%;
  }

  @media screen and (max-width: 640px) {
    .page-content {
      padding: var(--padding);
    }

    .content-area {
      flex: 1;
    }
  }
</style>
