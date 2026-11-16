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
  import { describeDownload, watchBridgeTraffic } from '$lib/utils/bridge-traffic'
  import { resolveProxyOrigin } from '$lib/utils/environment'
  import { formatBytes } from '$lib/utils/format'
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
  /** Hex characters of the reference in a saved file's name; raw data has no name of its own */
  const FILE_NAME_REFERENCE_CHARS = 8

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
      logStore.log(`Downloading data from reference: ${ref}`)
      const data = await clientStore.client!.downloadData(ref)
      const text = new TextDecoder().decode(data)
      logStore.log(describeDownload(stopWatching()))
      logStore.log(`Download successful! (${data.length} bytes)`)
      result = { title: 'Downloaded Data:', entries: [{ value: text }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Download failed: ${msg}`, 'error')
      error = msg
    } finally {
      stopWatching()
    }
  }

  /** `downloadDataStream`, saved to disk as it arrives; the bytes are never rendered. */
  async function handleStreamToDisk() {
    result = undefined
    error = undefined
    const ref = validReference()
    if (!ref) return

    const name = `swarm-${ref.slice(0, FILE_NAME_REFERENCE_CHARS)}.bin`
    const stopWatching = watchBridgeTraffic(resolveProxyOrigin())
    try {
      logStore.log(`Streaming data to disk from reference: ${ref}`)
      const download = await clientStore.client!.downloadDataStream(ref)
      const outcome = await saveStream(download.stream, name)
      if (outcome.path === 'cancelled') {
        logStore.log(`Save of ${name} cancelled in the picker; the download was stopped`)
        return
      }
      const elapsedTime = outcome.elapsedMs / MS_PER_SECOND
      logStore.log(describeDownload(stopWatching()))
      logStore.log(
        `Saved ${name} (${formatBytes(download.size)}) ${describeSave(outcome)} in ${elapsedTime.toFixed(2)}s`,
      )
      result = {
        title: 'Data streamed to disk:',
        entries: [
          { label: 'File', value: name },
          { label: 'Size', value: formatBytes(download.size) },
          { label: 'Saved', value: describeSave(outcome) },
          { label: 'Time', value: `${elapsedTime.toFixed(2)}s` },
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
    <CardTitle>Download Data</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input bind:value={reference} placeholder="Reference (64 hex chars)" />
    <div class="flex flex-wrap gap-2">
      <Button onclick={handleDownload} disabled={!clientStore.authenticated}>Download Data</Button>
      <Button variant="outline" onclick={handleStreamToDisk} disabled={!clientStore.authenticated}>
        Stream Data to Disk
      </Button>
    </div>
    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
