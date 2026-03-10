<script lang="ts">
  import Copy from 'carbon-icons-svelte/lib/Copy.svelte'
  import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
  import Button from '$lib/components/ui/button.svelte'

  const FEEDBACK_DURATION_MS = 5000

  let { text }: { text: string } = $props()

  let copied = $state(false)
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    copied = true

    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    timeoutId = setTimeout(() => {
      copied = false
    }, FEEDBACK_DURATION_MS)
  }
</script>

<Button variant="secondary" dimension="small" onclick={handleCopy}>
  {#if copied}
    <Checkmark size={16} />
  {:else}
    <Copy size={16} />
  {/if}
</Button>
