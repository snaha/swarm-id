<script lang="ts">
  import Button from '$lib/components/ui/button.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import type AddPostageStamp from '$lib/components/add-postage-stamp.svelte'
  import type { PageState, PurchaseState } from '$lib/components/add-postage-stamp.svelte'

  interface Props {
    pageState: PageState
    purchaseState: PurchaseState
    isFormDisabled: boolean
    stampRef: AddPostageStamp
  }

  let { pageState, purchaseState, isFormDisabled, stampRef }: Props = $props()
</script>

{#if pageState === 'purchase' && purchaseState === 'error'}
  <Horizontal --horizontal-gap="var(--half-padding)">
    <Button variant="strong" dimension="compact" onclick={() => stampRef.handlePurchase()}>
      Try again
    </Button>
    <Button variant="ghost" dimension="compact" onclick={() => stampRef.goToSelect()}>Back</Button>
  </Horizontal>
{:else if pageState === 'manual'}
  <Button dimension="compact" onclick={() => stampRef.handleAddStamp()} disabled={isFormDisabled}>
    Add postage stamp
  </Button>
{/if}
