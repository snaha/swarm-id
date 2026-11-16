<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import ResultDisplay from './result-display.svelte'
  import type { ResultData } from './result-types'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { formatBytes } from '$lib/utils/format'
  import { describeDownload, watchBridgeTraffic } from '$lib/utils/bridge-traffic'
  import { resolveProxyOrigin } from '$lib/utils/environment'
  import { describeSave, saveStream } from '$lib/utils/save-stream'

  interface Props {
    reference?: string
  }

  let { reference = $bindable('') }: Props = $props()

  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  const REFERENCE_LENGTH = 64
  const ENCRYPTED_REFERENCE_LENGTH = 128
  const MS_PER_SECOND = 1000

  /** The trimmed reference, or undefined once the invalid one is reported. */
  function validReference(): string | undefined {
    const ref = reference.trim()
    if (!ref || (ref.length !== REFERENCE_LENGTH && ref.length !== ENCRYPTED_REFERENCE_LENGTH)) {
      error = 'Invalid reference (must be 64 or 128 hex chars)'
      logStore.log('Invalid reference', 'error')
      return undefined
    }
    return ref
  }

  async function handleDownload() {
    result = undefined
    error = undefined
    const ref = validReference()
    if (!ref) return

    const stopWatching = watchBridgeTraffic(resolveProxyOrigin())
    try {
      logStore.log(`Downloading file from reference: ${ref}`)
      const downloadStartTime = Date.now()
      const fileData = await clientStore.client!.downloadFile(ref)
      const elapsedTime = (Date.now() - downloadStartTime) / 1000
      const speed = elapsedTime > 0 ? fileData.data.length / elapsedTime : 0
      logStore.log(describeDownload(stopWatching()))
      logStore.log(
        `Download successful! Filename: ${fileData.name} (${fileData.data.length} bytes)`,
      )

      // Trigger browser download
      const blob = new Blob([fileData.data])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileData.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Delay URL revocation to allow browser to process download
      setTimeout(() => URL.revokeObjectURL(url), 1000)

      result = {
        title: 'File downloaded:',
        entries: [
          { label: 'Filename', value: fileData.name },
          { label: 'Size', value: formatBytes(fileData.data.length) },
          { label: 'Time', value: `${elapsedTime.toFixed(2)}s` },
          { label: 'Speed', value: `${formatBytes(speed)}/s` },
        ],
        status: 'success',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Download failed: ${msg}`, 'error')
      error = msg
    } finally {
      stopWatching()
    }
  }

  /** `downloadFileStream`, saved to disk as it arrives; the bytes are never rendered. */
  async function handleStreamToDisk() {
    result = undefined
    error = undefined
    const ref = validReference()
    if (!ref) return

    const stopWatching = watchBridgeTraffic(resolveProxyOrigin())
    try {
      logStore.log(`Streaming file to disk from reference: ${ref}`)
      const download = await clientStore.client!.downloadFileStream(ref)
      const outcome = await saveStream(download.stream, download.name)
      if (outcome.path === 'cancelled') {
        logStore.log(`Save of ${download.name} cancelled in the picker; the download was stopped`)
        return
      }
      const elapsedTime = outcome.elapsedMs / MS_PER_SECOND
      const speed = elapsedTime > 0 ? download.size / elapsedTime : 0
      logStore.log(describeDownload(stopWatching()))
      logStore.log(
        `Saved ${download.name} (${formatBytes(download.size)}) ${describeSave(outcome)} in ${elapsedTime.toFixed(2)}s`,
      )
      result = {
        title: 'File streamed to disk:',
        entries: [
          { label: 'Filename', value: download.name },
          { label: 'Size', value: formatBytes(download.size) },
          { label: 'Saved', value: describeSave(outcome) },
          { label: 'Time', value: `${elapsedTime.toFixed(2)}s` },
          { label: 'Speed', value: `${formatBytes(speed)}/s` },
        ],
        status: 'success',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Streaming download failed: ${msg}`, 'error')
      error = msg
    } finally {
      stopWatching()
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Download File</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input bind:value={reference} placeholder="Reference (64 or 128 hex chars)" />
    <div class="flex flex-wrap gap-2">
      <Button onclick={handleDownload} disabled={!clientStore.authenticated}>Download File</Button>
      <Button variant="outline" onclick={handleStreamToDisk} disabled={!clientStore.authenticated}>
        Stream File to Disk
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">
      Streaming saves the file as it arrives, through the save picker where the browser has one;
      elsewhere it is collected and handed to the browser's download.
    </p>
    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
