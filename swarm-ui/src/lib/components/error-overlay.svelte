<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import SwarmLogo from '$lib/components/swarm-logo.svelte'

  interface Props {
    title: string
    description: string
    onTryAgain: () => void
  }

  let { title, description, onTryAgain }: Props = $props()
</script>

<div class="error-overlay">
  <div class="error-logo">
    <SwarmLogo fill="var(--colors-ultra-high)" height={30} />
  </div>
  <div class="error-content">
    <Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
      <Vertical --vertical-gap="var(--half-padding)">
        <Typography variant="h4" center>‼️ {title}</Typography>
        <Typography center>{description}</Typography>
      </Vertical>
      <Button variant="strong" onclick={onTryAgain}>Try again</Button>
    </Vertical>
  </div>
</div>

<style>
  .error-overlay {
    position: fixed;
    inset: 0;
    background: var(--colors-ultra-low);
    z-index: 100;
    display: flex;
    flex-direction: column;
    padding: var(--double-padding);
  }

  .error-content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  @media screen and (max-width: 640px) {
    .error-overlay {
      padding: var(--padding);
    }
  }
</style>
