<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import ResultDisplay from './result-display.svelte'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { bytesToHex } from '$lib/utils/hex'
  import { validateHex } from '$lib/utils/validation'
  import { extractContentFromFlatManifest, extractEntryFromManifest } from '@swarm-id/lib'
  import type { ResultData } from './result-types'

  interface Props {
    topic: string
    isEpoch: boolean
    isManifestCompat: boolean
    feedIndex: string
    downloadAt: string
    feedOwner: string
    encryptionKey: string
    onDownloadAtUpdate?: (at: string) => void
    onEncryptionKeyUpdate?: (key: string) => void
  }

  let {
    topic,
    isEpoch,
    isManifestCompat,
    feedIndex,
    downloadAt,
    feedOwner,
    encryptionKey,
    onDownloadAtUpdate,
    onEncryptionKeyUpdate,
  }: Props = $props()

  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)
  let downloading = $state(false)

  const DEFAULT_EPOCH_ENCRYPTION_KEY = '0'.repeat(64)

  function resolveEpochEncryptionKey(value: string): string {
    const key = (value || '').trim()
    return key || DEFAULT_EPOCH_ENCRYPTION_KEY
  }

  function getOwner(): string | undefined {
    const ownerRaw = feedOwner.trim()
    if (!ownerRaw) return undefined
    return ownerRaw.startsWith('0x') ? ownerRaw.slice(2) : ownerRaw
  }

  function getDownloadOptions(): Record<string, string> {
    const opts: Record<string, string> = {}
    if (feedIndex) opts.index = feedIndex
    if (downloadAt) opts.at = downloadAt
    return opts
  }

  async function handleDownloadPayload() {
    result = undefined
    error = undefined
    if (downloading) return
    downloading = true

    const topicErr = validateHex(topic, 64, 'Topic')
    if (topicErr) {
      error = topicErr
      logStore.log(topicErr, 'error')
      downloading = false
      return
    }
    const owner = getOwner()
    if (owner) {
      const ownerErr = validateHex(owner, 40, 'Owner')
      if (ownerErr) {
        error = ownerErr
        logStore.log(ownerErr, 'error')
        downloading = false
        return
      }
    }

    try {
      if (isManifestCompat) {
        logStore.log('Using manifest compatibility mode (flat manifest download)')

        let manifestReference: string

        logStore.log('Step 1: Downloading manifest reference from feed...')

        if (isEpoch) {
          let atRaw = downloadAt || Math.floor(Date.now() / 1000).toString()
          if (!downloadAt) onDownloadAtUpdate?.(atRaw)
          const reader = clientStore.client!.makeEpochFeedReader({ topic, owner })
          const feedResult = await reader.downloadRawReference({ at: atRaw })
          manifestReference = feedResult.reference ?? ''
          logStore.log(`Got manifest reference from epoch feed: ${manifestReference}`)
        } else {
          const reader = clientStore.client!.makeSequentialFeedReader({ topic, owner })
          const feedResult = await reader.downloadRawPayload(getDownloadOptions())
          const manifestRefBytes = feedResult.payload
          manifestReference = Array.from(manifestRefBytes)
            .map((b: number) => b.toString(16).padStart(2, '0'))
            .join('')
          logStore.log(
            `Got manifest reference from v1 payload: ${manifestReference} (index: ${feedResult.feedIndex})`,
          )
        }

        if (!manifestReference || manifestReference.length < 64) {
          error = 'Manifest reference not found or invalid'
          downloading = false
          return
        }

        logStore.log('Step 2: Downloading flat manifest data...')
        const manifestData = await clientStore.client!.downloadData(manifestReference)
        logStore.log(`Flat manifest downloaded: ${manifestData.length} bytes`)

        const childNodeRef = extractContentFromFlatManifest(manifestData)
        logStore.log(`Step 3: Extracted fork reference (child node): ${childNodeRef}`)

        if (!childNodeRef || childNodeRef.length < 64) {
          error = 'Child node reference not found in manifest'
          downloading = false
          return
        }

        logStore.log('Step 4: Downloading child manifest node...')
        const childNodeData = await clientStore.client!.downloadData(childNodeRef)
        logStore.log(`Child node downloaded: ${childNodeData.length} bytes`)

        const contentReference = extractEntryFromManifest(childNodeData)
        logStore.log(`Step 5: Extracted content reference from child: ${contentReference}`)

        if (!contentReference || contentReference.length < 64) {
          error = 'Content reference not found in child node'
          downloading = false
          return
        }

        logStore.log(`Step 6: Downloading content from reference ${contentReference}...`)
        const contentData = await clientStore.client!.downloadData(contentReference)
        const text = new TextDecoder().decode(contentData)

        result = {
          title: 'Feed Content Download (Hierarchical Manifest):',
          entries: [
            { label: 'Root Manifest', value: manifestReference },
            { label: 'Child Node', value: childNodeRef },
            { label: 'Content Reference', value: contentReference },
            { label: 'Content', value: text },
            { label: 'Size', value: `${contentData.length} bytes` },
          ],
          status: 'Four-step download complete (hierarchical manifest)',
          statusVariant: 'success',
        }
        logStore.log(`Hierarchical manifest download successful: ${contentData.length} bytes`)
      } else if (isEpoch) {
        let atRaw = downloadAt || Math.floor(Date.now() / 1000).toString()
        if (!downloadAt) onDownloadAtUpdate?.(atRaw)
        logStore.log(
          `Epoch download payload start: at=${atRaw} topic=${topic} owner=${owner || 'proxy'}`,
        )
        const reader = clientStore.client!.makeEpochFeedReader({ topic, owner })
        let key = resolveEpochEncryptionKey(encryptionKey)
        onEncryptionKeyUpdate?.(key)
        logStore.log(`Epoch download key: ${key.slice(0, 8)}... (allZero=${/^0+$/.test(key)})`)
        let feedResult = await reader.downloadPayload({ at: atRaw, encryptionKey: key })
        if (!feedResult.reference && owner) {
          logStore.log('Epoch download retrying without owner')
          const fallbackReader = clientStore.client!.makeEpochFeedReader({ topic })
          feedResult = await fallbackReader.downloadPayload({
            at: atRaw,
            encryptionKey: key,
          })
        }
        logStore.log(
          `Epoch download payload result: reference=${feedResult.reference || 'none'} payloadBytes=${feedResult.payload ? feedResult.payload.length : 0}`,
        )
        if (!feedResult.reference || !feedResult.payload) {
          result = {
            title: 'Epoch Feed Payload:',
            entries: [
              { value: 'Not found' },
              ...(feedResult.reference
                ? [{ label: 'Reference', value: feedResult.reference }]
                : []),
            ],
          }
          logStore.log('Epoch feed download payload not found')
        } else {
          const text = new TextDecoder().decode(feedResult.payload)
          const hex = bytesToHex(feedResult.payload)
          result = {
            title: 'Epoch Feed Payload:',
            entries: [
              { label: 'Payload', value: text },
              { label: 'Reference', value: feedResult.reference },
              { label: 'Payload (hex)', value: hex },
            ],
          }
          logStore.log('Epoch feed download successful')
        }
      } else {
        const reader = clientStore.client!.makeSequentialFeedReader({ topic, owner })
        if (!encryptionKey || encryptionKey.length !== 64) {
          error = 'Encryption key must be 64 hex chars'
          logStore.log('Missing encryption key', 'error')
          downloading = false
          return
        }
        const feedResult = await reader.downloadPayload(encryptionKey, getDownloadOptions())
        const text = new TextDecoder().decode(feedResult.payload)
        const hex = bytesToHex(feedResult.payload)
        result = {
          title: 'Sequential Payload:',
          entries: [
            { label: 'Payload', value: text },
            { label: 'Timestamp', value: String(feedResult.timestamp ?? 'N/A') },
            { label: 'Index', value: String(feedResult.feedIndex) },
            { label: 'Next', value: String(feedResult.feedIndexNext) },
            { label: 'Payload (hex)', value: hex },
          ],
        }
        logStore.log('Sequential feed download payload successful')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Feed download payload failed: ${msg}`, 'error')
      error = msg
    } finally {
      downloading = false
    }
  }

  async function handleDownloadReference() {
    result = undefined
    error = undefined
    if (downloading) return
    downloading = true

    const topicErr = validateHex(topic, 64, 'Topic')
    if (topicErr) {
      error = topicErr
      logStore.log(topicErr, 'error')
      downloading = false
      return
    }
    const owner = getOwner()
    if (owner) {
      const ownerErr = validateHex(owner, 40, 'Owner')
      if (ownerErr) {
        error = ownerErr
        logStore.log(ownerErr, 'error')
        downloading = false
        return
      }
    }

    try {
      if (isEpoch) {
        let atRaw = downloadAt || Math.floor(Date.now() / 1000).toString()
        if (!downloadAt) onDownloadAtUpdate?.(atRaw)
        logStore.log(
          `Epoch download reference start: at=${atRaw} topic=${topic} owner=${owner || 'proxy'}`,
        )
        const reader = clientStore.client!.makeEpochFeedReader({ topic, owner })
        let key = resolveEpochEncryptionKey(encryptionKey)
        onEncryptionKeyUpdate?.(key)
        logStore.log(`Epoch download key: ${key.slice(0, 8)}... (allZero=${/^0+$/.test(key)})`)
        let feedResult = await reader.downloadReference({
          at: atRaw,
          encryptionKey: key,
        })
        if (!feedResult.reference && owner) {
          logStore.log('Epoch download retrying without owner')
          const fallbackReader = clientStore.client!.makeEpochFeedReader({ topic })
          feedResult = await fallbackReader.downloadReference({
            at: atRaw,
            encryptionKey: key,
          })
        }
        result = {
          title: 'Epoch Feed Reference:',
          entries: [{ value: feedResult.reference || 'Not found' }],
        }
        logStore.log('Epoch feed download reference successful')
      } else {
        const reader = clientStore.client!.makeSequentialFeedReader({ topic, owner })
        if (!encryptionKey || encryptionKey.length !== 64) {
          error = 'Encryption key must be 64 hex chars'
          logStore.log('Missing encryption key', 'error')
          downloading = false
          return
        }
        const feedResult = await reader.downloadReference(encryptionKey, getDownloadOptions())
        result = {
          title: 'Sequential Reference:',
          entries: [
            { label: 'Reference', value: feedResult.reference },
            { label: 'Index', value: String(feedResult.feedIndex) },
            { label: 'Next', value: String(feedResult.feedIndexNext) },
          ],
        }
        logStore.log('Sequential feed download reference successful')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Feed download reference failed: ${msg}`, 'error')
      error = msg
    } finally {
      downloading = false
    }
  }
</script>

<h3 class="text-base font-semibold">Download</h3>
<Input
  value={downloadAt}
  oninput={(e) => onDownloadAtUpdate?.((e.target as HTMLInputElement).value)}
  placeholder="At (unix timestamp, optional)"
/>
<Input value={feedOwner} placeholder="Owner (40 hex chars, optional)" disabled />
<Input
  value={encryptionKey}
  oninput={(e) => onEncryptionKeyUpdate?.((e.target as HTMLInputElement).value)}
  placeholder="Encryption Key (64 hex chars, required for sequential download)"
  disabled={isManifestCompat}
/>
<div class="flex gap-2">
  <Button onclick={handleDownloadPayload} disabled={!clientStore.authenticated || downloading}>
    {isManifestCompat ? 'Download Content' : 'Download Payload'}
  </Button>
  {#if !isManifestCompat}
    <Button onclick={handleDownloadReference} disabled={!clientStore.authenticated || downloading}>
      Download Reference
    </Button>
  {/if}
</div>
<ResultDisplay {result} {error} />
