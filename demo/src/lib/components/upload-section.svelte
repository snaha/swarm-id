<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Label } from '$lib/components/ui/label'
  import ResultDisplay from './result-display.svelte'
  import type { ResultData } from './result-types'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'

  interface Props {
    onUploadResult?: (reference: string) => void
  }

  let { onUploadResult }: Props = $props()

  let data = $state('Hello, Swarm!')
  let encrypt = $state(true)
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  async function handleUpload() {
    result = undefined
    error = undefined

    if (!data) {
      error = 'Please enter data to upload'
      logStore.log('No data to upload', 'error')
      return
    }

    try {
      logStore.log(
        `Uploading data (${data.length} bytes, encryption: ${encrypt ? 'enabled' : 'disabled'})...`,
      )
      const encoder = new TextEncoder()
      const uint8Data = encoder.encode(data)

      const uploadResult = await clientStore.client!.uploadData(uint8Data, {
        pin: false,
        encrypt,
        deferred: clientStore.deferred,
      })
      logStore.log(
        `Upload successful! Reference: ${uploadResult.reference} (${uploadResult.reference.length} chars)`,
      )
      result = {
        title: `Reference ${encrypt ? '(Encrypted)' : ''}:`,
        entries: [{ value: uploadResult.reference }],
        footnote: `${uploadResult.reference.length} hex chars (${uploadResult.reference.length / 2} bytes)`,
      }
      onUploadResult?.(uploadResult.reference)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Upload failed: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Upload Data</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Textarea bind:value={data} placeholder="Enter data to upload..." rows={3} />

    <div class="space-y-3">
      <div class="flex items-start gap-2">
        <Checkbox bind:checked={encrypt} id="encrypt" />
        <div>
          <Label for="encrypt" class="cursor-pointer">Enable encryption (recommended)</Label>
          <p class="text-xs text-muted-foreground mt-1">
            When enabled, data is encrypted with unique keys. Reference will be 128 chars (64
            bytes).
          </p>
        </div>
      </div>

      <div class="flex items-start gap-2">
        <Checkbox bind:checked={clientStore.deferred} id="deferred" />
        <div>
          <Label for="deferred" class="cursor-pointer">Deferred upload mode</Label>
          <p class="text-xs text-muted-foreground mt-1">
            Required for dev mode. Uncheck for direct uploads in production.
          </p>
        </div>
      </div>
    </div>

    <Button onclick={handleUpload} disabled={!clientStore.canUpload}>Upload Data</Button>

    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
