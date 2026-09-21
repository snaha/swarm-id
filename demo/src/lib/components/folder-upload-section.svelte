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
  import { collectionPath } from '@snaha/swarm-id'

  interface Props {
    onUploadResult?: (reference: string) => void
  }

  let { onUploadResult }: Props = $props()

  let files = $state<File[]>([])
  let indexDocument = $state('index.html')
  let encrypt = $state(true)
  let progress = $state<{ processed: number; total: number } | undefined>(undefined)
  let isUploading = $state(false)
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  const totalBytes = $derived(files.reduce((sum, file) => sum + file.size, 0))

  function handleSelect(event: Event) {
    // The picked folder's own name is the first path segment; it does not
    // reach the manifest. The library drops it (`collectionPath`), and so does
    // the preview here.
    files = Array.from((event.target as HTMLInputElement).files ?? [])
    result = undefined
    error = undefined
  }

  async function handleUpload() {
    result = undefined
    error = undefined
    progress = undefined
    isUploading = true
    const startTime = Date.now()

    try {
      logStore.log(`Uploading folder: ${files.length} files, ${formatBytes(totalBytes)}...`)
      const uploadResult = await clientStore.client!.uploadFiles(files, {
        encrypt,
        indexDocument: indexDocument || undefined,
        deferred: clientStore.deferred,
        onProgress: (p) => (progress = p),
      })
      const elapsed = (Date.now() - startTime) / 1000
      logStore.log(`Folder uploaded! Reference: ${uploadResult.reference}`)
      result = {
        title: `Folder uploaded (${encrypt ? 'Encrypted' : 'Not Encrypted'}):`,
        entries: [
          { label: 'Reference', value: uploadResult.reference },
          { label: 'Files', value: `${files.length}` },
          { label: 'Bytes', value: formatBytes(totalBytes) },
          { label: 'Time', value: `${elapsed.toFixed(2)}s` },
        ],
        footnote: encrypt
          ? 'The reference carries the key: read the folder back with listFiles and downloadFile, never from a gateway URL.'
          : 'Anyone with the reference can read the folder at /bzz/<reference>/.',
      }
      onUploadResult?.(uploadResult.reference)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Folder upload failed: ${msg}`, 'error')
      error = msg
    } finally {
      isUploading = false
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Upload Folder</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input type="file" webkitdirectory multiple onchange={handleSelect} />

    {#if files.length > 0}
      <p class="text-sm text-muted-foreground">
        {files.length} files, {formatBytes(totalBytes)}: {files
          .slice(0, 3)
          .map(collectionPath)
          .join(', ')}{files.length > 3 ? ', …' : ''}
      </p>
    {/if}

    <div class="space-y-3">
      <div class="flex items-center gap-2">
        <Label for="folder-index">Index document</Label>
        <Input id="folder-index" class="w-48" bind:value={indexDocument} placeholder="index.html" />
      </div>

      <div class="flex items-start gap-2">
        <Checkbox id="folder-encrypt" bind:checked={encrypt} />
        <div>
          <Label for="folder-encrypt" class="cursor-pointer">Enable encryption (recommended)</Label>
          <p class="text-xs text-muted-foreground mt-1">
            Every file and the manifest are encrypted; the 128-char reference carries the key.
          </p>
        </div>
      </div>
    </div>

    <Button
      onclick={handleUpload}
      disabled={!clientStore.canUpload || files.length === 0 || isUploading}
    >
      {isUploading ? 'Uploading...' : 'Upload Folder'}
    </Button>

    {#if isUploading && progress}
      <div class="space-y-1">
        <div class="flex justify-between text-sm text-muted-foreground">
          <span>Uploading...</span>
          <span>{progress.processed}/{progress.total} files</span>
        </div>
        <div class="h-2 bg-muted rounded-full overflow-hidden">
          <div
            class="h-full bg-primary transition-all"
            style="width: {(progress.processed / progress.total) * 100}%"
          ></div>
        </div>
      </div>
    {/if}

    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
