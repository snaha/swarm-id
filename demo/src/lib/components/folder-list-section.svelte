<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import ResultDisplay from './result-display.svelte'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { formatBytes } from '$lib/utils/format'
  import type { CollectionEntry } from '@snaha/swarm-id'

  interface Props {
    reference?: string
  }

  let { reference = $bindable('') }: Props = $props()

  let entries = $state<CollectionEntry[] | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  async function handleList() {
    entries = undefined
    error = undefined
    try {
      logStore.log(`Listing folder: ${reference.trim()}`)
      entries = await clientStore.client!.listFiles(reference.trim())
      logStore.log(`Folder has ${entries.length} files`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Listing failed: ${msg}`, 'error')
      error = msg
    }
  }

  async function handleDownload(entry: CollectionEntry) {
    try {
      const data = await clientStore.client!.downloadData(entry.reference)
      logStore.log(`Downloaded ${entry.path} (${formatBytes(data.length)})`)
      const url = URL.createObjectURL(new Blob([data], { type: entry.contentType }))
      const a = document.createElement('a')
      a.href = url
      a.download = entry.path.split('/').pop() ?? entry.path
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Download of ${entry.path} failed: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>List Folder</CardTitle>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input bind:value={reference} placeholder="Folder reference (64 or 128 hex chars)" />
    <Button onclick={handleList} disabled={!clientStore.authenticated || !reference.trim()}>
      List Files
    </Button>

    {#if entries}
      {#if entries.length === 0}
        <p class="text-sm text-muted-foreground">The manifest has no files.</p>
      {:else}
        <table class="w-full text-sm">
          <tbody>
            {#each entries as entry (entry.path)}
              <tr class="border-t border-border">
                <td class="py-1 pr-2 font-mono">{entry.path}</td>
                <td class="py-1 pr-2 text-muted-foreground">{entry.contentType ?? ''}</td>
                <td class="py-1 text-right">
                  <Button variant="outline" size="sm" onclick={() => handleDownload(entry)}>
                    Download
                  </Button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}

    <ResultDisplay result={undefined} {error} />
  </CardContent>
</Card>
