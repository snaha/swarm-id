<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
  import { Textarea } from '$lib/components/ui/textarea'
  import AsyncButton from './async-button.svelte'
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
  let useWebSocket = $state(false)
  let useWorkers = $state(true)
  let workerCount = $state(navigator.hardwareConcurrency ?? 4)
  let concurrency = $state(32)
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
        encrypt,
        deferred: clientStore.deferred,
        useWebSocket,
        useWorkers,
        workerCount: useWorkers ? workerCount : undefined,
        concurrency,
        batchID: clientStore.uploadBatchID,
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

      <div class="flex items-start gap-2">
        <Checkbox bind:checked={useWebSocket} id="data-ws" />
        <div>
          <Label for="data-ws" class="cursor-pointer">Use WebSocket upload</Label>
          <p class="text-xs text-muted-foreground mt-1">
            Stream chunks over WebSocket instead of HTTP.
          </p>
        </div>
      </div>

      <div class="flex items-start gap-2">
        <Checkbox bind:checked={useWorkers} id="data-workers" />
        <div>
          <Label for="data-workers" class="cursor-pointer">Use Web Workers for stamping</Label>
          <p class="text-xs text-muted-foreground mt-1">
            Parallel ECDSA signing across CPU cores. Speeds up large uploads.
          </p>
        </div>
      </div>

      {#if useWorkers}
        <div class="flex items-center gap-2 pl-6">
          <Label for="data-worker-count">Worker count</Label>
          <input
            id="data-worker-count"
            type="number"
            min="1"
            max="32"
            class="w-20 rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={workerCount}
          />
        </div>
      {/if}

      <div class="flex items-center gap-2">
        <Label for="data-concurrency">Upload concurrency</Label>
        <input
          id="data-concurrency"
          type="number"
          min="1"
          max="128"
          class="w-20 rounded-md border border-input bg-background px-3 py-1 text-sm"
          bind:value={concurrency}
        />
      </div>
    </div>

    <AsyncButton onclick={handleUpload} disabled={!clientStore.canUpload} loadingText="Uploading…">
      Upload Data
    </AsyncButton>

    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
