<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
  import type AddPostageStamp from '$lib/components/add-postage-stamp.svelte'
  import type {
    PageState,
    PurchaseState,
    StampVariant,
  } from '$lib/components/add-postage-stamp.svelte'

  interface Props {
    pageState: PageState
    purchaseState: PurchaseState
    isFormDisabled: boolean
    stampRef: AddPostageStamp
    variant?: StampVariant
    appName?: string
    onGoToApp?: () => void
    onSkip?: () => void
  }

  let {
    pageState,
    purchaseState,
    isFormDisabled,
    stampRef,
    variant = 'dashboard',
    appName,
    onGoToApp,
    onSkip,
  }: Props = $props()
</script>

{#if pageState === 'purchase' && purchaseState === 'success'}
  <Horizontal --horizontal-justify-content="center" style="width: 100%;">
    {#if variant === 'account-creation'}
      <Button variant="strong" dimension="compact" onclick={() => stampRef.handleContinue()}>
        Continue to app
        <ArrowRight size={20} />
      </Button>
    {:else if variant === 'external-app'}
      <Horizontal --horizontal-gap="var(--half-padding)">
        <Button variant="ghost" dimension="compact" onclick={() => stampRef.handleContinue()}>
          Go to Swarm ID
        </Button>
        <Button variant="strong" dimension="compact" onclick={onGoToApp}>
          Go to {appName}
          <ArrowRight size={20} />
        </Button>
      </Horizontal>
    {:else}
      <Button variant="strong" dimension="compact" onclick={() => stampRef.handleContinue()}>
        Back to Swarm ID
      </Button>
    {/if}
  </Horizontal>
{:else if pageState === 'purchase' && purchaseState === 'error'}
  <Horizontal --horizontal-justify-content="center" style="width: 100%;">
    <Button variant="strong" dimension="compact" onclick={() => stampRef.goToSelect()}>
      Try again
    </Button>
  </Horizontal>
{:else if pageState === 'manual'}
  <Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
    <Button dimension="compact" onclick={() => stampRef.handleAddStamp()} disabled={isFormDisabled}>
      <Checkmark size={20} />
      Confirm
    </Button>
    {#if onSkip}
      <Typography variant="small">
        Not ready? <button class="link" onclick={onSkip}>Skip this step</button> and create a local account
        instead (limited to viewing only).
      </Typography>
    {/if}
  </Horizontal>
{/if}

<style>
  .link {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
</style>
