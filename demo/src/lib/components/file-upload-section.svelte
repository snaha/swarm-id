<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import Checkbox from '$lib/components/ui/checkbox/checkbox.svelte'
  import Label from '$lib/components/ui/label/label.svelte'
  import ResultDisplay from './result-display.svelte'
  import type { ResultData } from './result-types'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { formatBytes } from '$lib/utils/format'

  interface Props {
    onUploadResult?: (reference: string) => void
  }

  let { onUploadResult }: Props = $props()

  let selectedFile: File | undefined = $state(undefined)
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)
  let enableEncryption = $state(true)
  let useWebSocket = $state(false)
  let useWorkers = $state(true)
  let workerCount = $state(navigator.hardwareConcurrency ?? 4)
  let concurrency = $state(32)
  let uploadProgress = $state<{ processed: number; total: number } | undefined>(undefined)
  let isUploading = $state(false)
  let uploadStartTime = $state<number | undefined>(undefined)
  let chunkSplittingTime = $state<number | undefined>()

  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement
    selectedFile = input.files?.[0]
    result = undefined
    error = undefined
  }

  async function handleUpload() {
    result = undefined
    error = undefined
    uploadProgress = undefined

    if (!selectedFile) {
      error = 'Please select a file to upload'
      logStore.log('No file selected', 'error')
      return
    }

    isUploading = true
    uploadStartTime = Date.now()
    chunkSplittingTime = undefined

    try {
      const encryptionStatus = enableEncryption ? 'encrypted' : 'no encryption'
      logStore.log(
        `Uploading file: ${selectedFile.name} (${selectedFile.size} bytes, ${encryptionStatus})...`,
      )

      const progressTracker = { total: 0 }
      const uploadResult = await clientStore.client!.uploadFile(selectedFile, selectedFile.name, {
        encrypt: enableEncryption,
        encryptManifest: enableEncryption,
        useWebSocket,
        useWorkers,
        workerCount: useWorkers ? workerCount : undefined,
        concurrency,
        onProgress: (progress) => {
          uploadProgress = progress
          progressTracker.total = progress.total
          if (!chunkSplittingTime) {
            chunkSplittingTime = Date.now()
          }
        },
      })

      const elapsedTime = (Date.now() - uploadStartTime) / 1000
      const totalChunks = progressTracker.total
      const bytesUploaded = totalChunks * 4096
      const speed = elapsedTime > 0 ? bytesUploaded / elapsedTime : 0
      const splittingTime = ((chunkSplittingTime ?? uploadStartTime) - uploadStartTime) / 1000
      const uploadOnlyTime = elapsedTime - splittingTime
      const uploadSpeed = uploadOnlyTime > 0 ? bytesUploaded / uploadOnlyTime : 0

      logStore.log(`Upload successful! Reference: ${uploadResult.reference}`)

      // Surface any partition the proxy just claimed during the lease
      // bootstrap so the stamp panel transitions from "Inactive" → "N".
      void clientStore.refreshConnectionInfo()

      const encryptionLabel = enableEncryption ? 'Encrypted' : 'Not Encrypted'

      result = {
        title: `File uploaded (${encryptionLabel}):`,
        entries: [
          { label: 'Reference', value: uploadResult.reference },
          { label: 'Filename', value: selectedFile.name },
          { label: 'Chunks uploaded', value: `${totalChunks}` },
          { label: 'Bytes uploaded', value: formatBytes(bytesUploaded) },
          { label: 'Time', value: `${elapsedTime.toFixed(2)}s` },
          {
            label: 'Chunk splitting',
            value: `${splittingTime.toFixed(2)}s`,
          },
          { label: 'Upload time', value: `${uploadOnlyTime.toFixed(2)}s` },
          { label: 'Upload speed', value: `${formatBytes(uploadSpeed)}/s` },
          { label: 'Overall speed', value: `${formatBytes(speed)}/s` },
        ],
        footnote: `${uploadResult.reference.length} hex chars (${
          uploadResult.reference.length / 2
        } bytes)`,
      }
      onUploadResult?.(uploadResult.reference)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Upload failed: ${msg}`, 'error')
      error = msg
    } finally {
      isUploading = false
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Upload File</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input type="file" onchange={handleFileSelect} />

    {#if selectedFile}
      <p class="text-sm text-muted-foreground">
        Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
      </p>
    {/if}

    <div class="space-y-3">
      <div class="flex items-start gap-2">
        <Checkbox id="encrypt" bind:checked={enableEncryption} />
        <div>
          <Label for="encrypt" class="cursor-pointer">Enable encryption (recommended)</Label>
          <p class="text-xs text-muted-foreground mt-1">
            When enabled, data is encrypted with unique keys. Reference will be 128 chars (64
            bytes).
          </p>
        </div>
      </div>

      <div class="flex items-start gap-2">
        <Checkbox id="file-ws" bind:checked={useWebSocket} />
        <div>
          <Label for="file-ws" class="cursor-pointer">Use WebSocket upload</Label>
          <p class="text-xs text-muted-foreground mt-1">
            Stream chunks over WebSocket instead of HTTP.
          </p>
        </div>
      </div>

      <div class="flex items-start gap-2">
        <Checkbox id="file-workers" bind:checked={useWorkers} />
        <div>
          <Label for="file-workers" class="cursor-pointer">Use Web Workers for stamping</Label>
          <p class="text-xs text-muted-foreground mt-1">
            Parallel ECDSA signing across CPU cores. Speeds up large uploads.
          </p>
        </div>
      </div>

      {#if useWorkers}
        <div class="flex items-center gap-2 pl-6">
          <Label for="file-worker-count">Worker count</Label>
          <input
            id="file-worker-count"
            type="number"
            min="1"
            max="32"
            class="w-20 rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={workerCount}
          />
        </div>
      {/if}

      <div class="flex items-center gap-2">
        <Label for="file-concurrency">Upload concurrency</Label>
        <input
          id="file-concurrency"
          type="number"
          min="1"
          max="128"
          class="w-20 rounded-md border border-input bg-background px-3 py-1 text-sm"
          bind:value={concurrency}
        />
      </div>
    </div>

    <Button
      onclick={handleUpload}
      disabled={!clientStore.canUpload || !selectedFile || isUploading}
    >
      {isUploading ? 'Uploading...' : 'Upload File'}
    </Button>

    {#if isUploading && uploadProgress}
      <div class="space-y-1">
        <div class="flex justify-between text-sm text-muted-foreground">
          <span>Uploading...</span>
          <span>{uploadProgress.processed}/{uploadProgress.total} chunks</span>
        </div>
        <div class="h-2 bg-muted rounded-full overflow-hidden">
          <div
            class="h-full bg-primary transition-all"
            style="width: {(uploadProgress.processed / uploadProgress.total) * 100}%"
          ></div>
        </div>
      </div>
    {/if}

    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
