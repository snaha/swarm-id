<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import type { PageState, PurchaseState } from '$lib/components/add-postage-stamp.svelte'

  interface Props {
    pageState: PageState
    purchaseState: PurchaseState
    isFormDisabled: boolean
    onTryAgain: () => void
    onBack: () => void
    onAddStamp: () => void
  }

  let { pageState, purchaseState, isFormDisabled, onTryAgain, onBack, onAddStamp }: Props = $props()
</script>

{#if pageState === 'purchase' && purchaseState === 'error'}
  <Horizontal --horizontal-gap="var(--half-padding)">
    <Button variant="strong" dimension="compact" onclick={onTryAgain}>Try again</Button>
    <Button variant="ghost" dimension="compact" onclick={onBack}>Back</Button>
  </Horizontal>
{:else if pageState === 'manual'}
  <Button dimension="compact" onclick={onAddStamp} disabled={isFormDisabled}>
    Add postage stamp
  </Button>
{/if}
