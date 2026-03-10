<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import ResultDisplay from './result-display.svelte'
  import type { ResultData } from './result-types'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'

  interface Props {
    reference?: string
  }

  let { reference = $bindable('') }: Props = $props()

  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  const REFERENCE_LENGTH = 64
  const ENCRYPTED_REFERENCE_LENGTH = 128

  async function handleDownload() {
    result = undefined
    error = undefined
    const ref = reference.trim()

    if (!ref || (ref.length !== REFERENCE_LENGTH && ref.length !== ENCRYPTED_REFERENCE_LENGTH)) {
      error = 'Invalid reference (must be 64 or 128 hex chars)'
      logStore.log('Invalid reference', 'error')
      return
    }

    try {
      logStore.log(`Downloading data from reference: ${ref}`)
      const data = await clientStore.client!.downloadData(ref)
      const text = new TextDecoder().decode(data)
      logStore.log(`Download successful! (${data.length} bytes)`)
      result = { title: 'Downloaded Data:', entries: [{ value: text }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Download failed: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Download Data</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input bind:value={reference} placeholder="Reference (64 hex chars)" />
    <Button onclick={handleDownload} disabled={!clientStore.authenticated}>Download Data</Button>
    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
