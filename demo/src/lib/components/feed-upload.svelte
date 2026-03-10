<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import ResultDisplay from './result-display.svelte'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import { buildV1Payload, hexToBytes } from '$lib/utils/hex'
  import { validateHex } from '$lib/utils/validation'
  import { buildBzzManifestNode, saveMantarayTreeRecursively } from '@swarm-id/lib'
  import type { ResultData } from './result-types'

  interface Props {
    topic: string
    isEpoch: boolean
    isManifestCompat: boolean
    feedIndex: string
    feedAt: string
    uploadEncryptionKey: string
    onOwnerUpdate?: (owner: string) => void
    onDownloadAtUpdate?: (at: string) => void
    onFeedAtClear?: () => void
    onEncryptionKeyUpdate?: (key: string) => void
    onUploadEncryptionKeyUpdate?: (key: string) => void
  }

  let {
    topic,
    isEpoch,
    isManifestCompat,
    feedIndex,
    feedAt,
    uploadEncryptionKey,
    onOwnerUpdate,
    onDownloadAtUpdate,
    onFeedAtClear,
    onEncryptionKeyUpdate,
    onUploadEncryptionKeyUpdate,
  }: Props = $props()

  let payload = $state('Hello feed!')
  let uploadReference = $state('0000000000000000000000000000000000000000000000000000000000000000')
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)
  let uploading = $state(false)

  const DEFAULT_EPOCH_ENCRYPTION_KEY = '0'.repeat(64)

  function resolveEpochEncryptionKey(value: string): string {
    const key = (value || '').trim()
    return key || DEFAULT_EPOCH_ENCRYPTION_KEY
  }

  function incrementPayloadValue(value: string): string {
    const match = value.match(/^(.*?)(\d+)\s*$/)
    if (!match) return `${value}1`
    const prefix = match[1]
    const num = BigInt(match[2])
    return `${prefix}${(num + 1n).toString()}`
  }

  function getUploadOptions(): Record<string, string> {
    const opts: Record<string, string> = {}
    if (feedIndex) opts.index = feedIndex
    if (feedAt) opts.at = feedAt
    return opts
  }

  async function handleUploadPayload() {
    result = undefined
    error = undefined
    if (uploading) return
    uploading = true

    const topicErr = validateHex(topic, 64, 'Topic')
    if (topicErr) {
      error = topicErr
      logStore.log(topicErr, 'error')
      uploading = false
      return
    }
    if (!payload) {
      error = 'Please enter payload'
      logStore.log('No payload provided', 'error')
      uploading = false
      return
    }

    try {
      const options = getUploadOptions()

      if (isManifestCompat) {
        logStore.log('Using manifest compatibility mode (flat manifest)', 'info')

        const uint8Data = new TextEncoder().encode(payload)
        const deferred = clientStore.deferred
        logStore.log(
          `Step 1: Uploading content (${uint8Data.length} bytes, deferred: ${deferred})...`,
        )
        const uploadResult = await clientStore.client!.uploadData(uint8Data, {
          pin: false,
          encrypt: false,
          deferred,
        })
        const contentReference = uploadResult.reference
        logStore.log(`Content uploaded: ${contentReference}`)

        logStore.log('Step 2: Building MantarayNode manifest...')
        const { manifestNode } = buildBzzManifestNode(contentReference)

        logStore.log('Step 3: Uploading manifest (children first, then root)...')
        const manifestResult = await saveMantarayTreeRecursively(
          manifestNode,
          async (data: Uint8Array, isRoot: boolean) => {
            logStore.log(`  Uploading ${isRoot ? 'root' : 'child'} node (${data.length} bytes)...`)
            const uploadResult = await clientStore.client!.uploadData(data, {
              pin: false,
              encrypt: false,
              deferred,
            })
            return { reference: uploadResult.reference }
          },
        )
        const manifestReference = manifestResult.rootReference
        logStore.log(`Manifest uploaded: ${manifestReference}`)

        logStore.log('Step 4: Uploading manifest reference to feed...')

        if (isEpoch) {
          let atRaw = feedAt || Math.floor(Date.now() / 1000).toString()
          const writer = clientStore.client!.makeEpochFeedWriter({ topic })
          const feedResult = await writer.uploadRawReference(manifestReference, {
            at: atRaw,
          })

          onDownloadAtUpdate?.(atRaw)
          try {
            onOwnerUpdate?.((await writer.getOwner()) || '')
          } catch {
            /* ignore */
          }

          result = {
            title: 'Epoch Feed Upload (Manifest Compat):',
            entries: [
              { label: 'Content Reference', value: contentReference },
              { label: 'Manifest Reference', value: manifestReference },
              { label: 'SOC Address', value: feedResult.socAddress },
            ],
            status: 'v1 format upload complete - accessible via /bzz/{feed-manifest}/',
            statusVariant: 'success',
          }
          logStore.log(`Epoch feed upload (v1 compat) successful: soc=${feedResult.socAddress}`)
        } else {
          const writer = clientStore.client!.makeSequentialFeedWriter({ topic })
          const timestamp = Math.floor(Date.now() / 1000)
          const v1Payload = buildV1Payload(manifestReference, timestamp)
          const feedResult = await writer.uploadRawPayload(v1Payload, {
            ...options,
            pin: false,
            deferred,
            hasTimestamp: false,
          })

          onOwnerUpdate?.(feedResult.owner || '')
          onDownloadAtUpdate?.('')
          onFeedAtClear?.()
          payload = incrementPayloadValue(payload)

          const currentIndex = feedResult.feedIndex ?? 'N/A'
          logStore.log(`Feed upload result - index: ${currentIndex}, owner: ${feedResult.owner}`)

          result = {
            title: 'Sequential Feed Upload (Manifest Compat):',
            entries: [
              { label: 'Content Reference', value: contentReference },
              { label: 'Manifest Reference', value: manifestReference },
              { label: 'Feed Index', value: String(currentIndex) },
              { label: 'Owner', value: feedResult.owner },
              { label: 'SOC Reference', value: feedResult.reference },
            ],
            status: 'v1 format upload complete - accessible via /bzz/{feed-manifest}/',
            statusVariant: 'success',
          }
          logStore.log(`Sequential feed upload (v1 compat) successful: index=${currentIndex}`)
        }
      } else {
        if (isEpoch) {
          let atRaw = feedAt || Math.floor(Date.now() / 1000).toString()
          const writer = clientStore.client!.makeEpochFeedWriter({ topic })
          const epochEncKey = resolveEpochEncryptionKey(uploadEncryptionKey)
          if (epochEncKey.length !== 64) {
            error = 'Upload encryption key must be 64 hex chars'
            logStore.log('Invalid upload encryption key', 'error')
            uploading = false
            return
          }
          const uploadResult = await writer.uploadPayload(payload, {
            at: atRaw,
            encryptionKey: epochEncKey,
          })
          logStore.log(
            `Epoch upload key: ${epochEncKey.slice(0, 8)}... (allZero=${/^0+$/.test(epochEncKey)})`,
          )
          onEncryptionKeyUpdate?.(epochEncKey)
          onUploadEncryptionKeyUpdate?.(epochEncKey)
          onDownloadAtUpdate?.(atRaw)
          try {
            onOwnerUpdate?.((await writer.getOwner()) || '')
          } catch {
            /* ignore */
          }
          result = {
            title: 'Epoch Feed Upload Result:',
            entries: [
              { label: 'SOC', value: uploadResult.socAddress },
              { label: 'Reference', value: uploadResult.reference || 'N/A' },
            ],
          }
          logStore.log(
            `Epoch feed upload successful: soc=${uploadResult.socAddress} at=${atRaw} topic=${topic}`,
          )
        } else {
          const writer = clientStore.client!.makeSequentialFeedWriter({ topic })
          if (uploadEncryptionKey && uploadEncryptionKey.length !== 64) {
            error = 'Upload encryption key must be 64 hex chars'
            logStore.log('Invalid upload encryption key', 'error')
            uploading = false
            return
          }
          const uploadResult = uploadEncryptionKey
            ? await writer.uploadRawPayload(payload, {
                ...options,
                encryptionKey: uploadEncryptionKey,
              })
            : await writer.uploadPayload(payload, options)
          onEncryptionKeyUpdate?.(uploadResult.encryptionKey || uploadEncryptionKey || '')
          const currentIndex = uploadResult.feedIndex ?? 'N/A'
          result = {
            title: 'Sequential Payload Upload:',
            entries: [
              { label: 'Index', value: String(currentIndex) },
              { label: 'Reference', value: uploadResult.reference },
              { label: 'Owner', value: uploadResult.owner },
              { label: 'Encryption Key', value: uploadResult.encryptionKey || 'N/A' },
            ],
          }
          onOwnerUpdate?.(uploadResult.owner || '')
          onDownloadAtUpdate?.('')
          onFeedAtClear?.()
          payload = incrementPayloadValue(payload)
          logStore.log(`Sequential payload upload successful: ${uploadResult.reference}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Feed upload payload failed: ${msg}`, 'error')
      error = msg
    } finally {
      uploading = false
    }
  }

  async function handleUploadReference() {
    result = undefined
    error = undefined
    if (uploading) return
    uploading = true

    const topicErr = validateHex(topic, 64, 'Topic')
    if (topicErr) {
      error = topicErr
      logStore.log(topicErr, 'error')
      uploading = false
      return
    }
    const ref = uploadReference.trim()
    if (!ref || (ref.length !== 64 && ref.length !== 128)) {
      error = 'Reference must be 64 or 128 hex chars'
      logStore.log('Invalid reference', 'error')
      uploading = false
      return
    }

    try {
      const options = getUploadOptions()

      if (isEpoch) {
        let atRaw = feedAt || Math.floor(Date.now() / 1000).toString()
        const writer = clientStore.client!.makeEpochFeedWriter({ topic })
        const epochEncKey = resolveEpochEncryptionKey(uploadEncryptionKey)
        if (epochEncKey.length !== 64) {
          error = 'Upload encryption key must be 64 hex chars'
          logStore.log('Invalid upload encryption key', 'error')
          uploading = false
          return
        }
        const uploadResult = await writer.uploadReference(ref, {
          at: atRaw,
          encryptionKey: epochEncKey,
        })
        logStore.log(
          `Epoch upload key: ${epochEncKey.slice(0, 8)}... (allZero=${/^0+$/.test(epochEncKey)})`,
        )
        onEncryptionKeyUpdate?.(epochEncKey)
        onUploadEncryptionKeyUpdate?.(epochEncKey)
        onDownloadAtUpdate?.(atRaw)
        try {
          onOwnerUpdate?.((await writer.getOwner()) || '')
        } catch {
          /* ignore */
        }
        result = {
          title: 'Epoch Feed Upload Result:',
          entries: [
            { label: 'SOC', value: uploadResult.socAddress },
            { label: 'Reference', value: uploadResult.reference || 'N/A' },
          ],
        }
        logStore.log(
          `Epoch feed upload successful: soc=${uploadResult.socAddress} at=${atRaw} topic=${topic}`,
        )
      } else {
        const writer = clientStore.client!.makeSequentialFeedWriter({ topic })
        if (uploadEncryptionKey && uploadEncryptionKey.length !== 64) {
          error = 'Upload encryption key must be 64 hex chars'
          logStore.log('Invalid upload encryption key', 'error')
          uploading = false
          return
        }
        const uploadResult = uploadEncryptionKey
          ? await writer.uploadRawPayload(hexToBytes(ref), {
              ...options,
              encryptionKey: uploadEncryptionKey,
            })
          : await writer.uploadReference(ref, options)
        onEncryptionKeyUpdate?.(uploadResult.encryptionKey || uploadEncryptionKey || '')
        const currentIndex = uploadResult.feedIndex ?? 'N/A'
        result = {
          title: 'Sequential Reference Upload:',
          entries: [
            { label: 'Index', value: String(currentIndex) },
            { label: 'Reference', value: uploadResult.reference },
            { label: 'Owner', value: uploadResult.owner },
            { label: 'Encryption Key', value: uploadResult.encryptionKey || 'N/A' },
          ],
        }
        onOwnerUpdate?.(uploadResult.owner || '')
        onDownloadAtUpdate?.('')
        onFeedAtClear?.()
        logStore.log(`Sequential reference upload successful: ${uploadResult.reference}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Feed upload reference failed: ${msg}`, 'error')
      error = msg
    } finally {
      uploading = false
    }
  }
</script>

<h3 class="text-base font-semibold">Upload</h3>
<Input
  value={uploadEncryptionKey}
  oninput={(e) => onUploadEncryptionKeyUpdate?.((e.target as HTMLInputElement).value)}
  placeholder="Upload Encryption Key (64 hex chars, optional)"
  disabled={isManifestCompat}
/>
<Textarea bind:value={payload} placeholder="Payload to upload..." rows={2} />
<Input bind:value={uploadReference} placeholder="Reference (64/128 hex chars)" />
<div class="flex gap-2">
  <Button onclick={handleUploadPayload} disabled={!clientStore.canUpload || uploading}>
    {isManifestCompat ? 'Upload Content' : 'Upload Payload'}
  </Button>
  {#if !isManifestCompat}
    <Button onclick={handleUploadReference} disabled={!clientStore.canUpload || uploading}>
      Upload Reference
    </Button>
  {/if}
</div>
<ResultDisplay {result} {error} />
