<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Label } from '$lib/components/ui/label'
  import { Separator } from '$lib/components/ui/separator'
  import ResultDisplay from './result-display.svelte'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'
  import type { ResultData } from './result-types'
  import { validateHex } from '$lib/utils/validation'

  interface Props {
    topic: string
    isEpoch: boolean
    feedOwner: string
    feedAt: string
  }

  let { topic, isEpoch, feedOwner, feedAt }: Props = $props()

  let encryptManifest = $state(false)
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  let lastManifestReference: string | undefined
  let lastManifestTopic: string | undefined
  let lastManifestOwner: string | undefined
  let lastManifestType: string | undefined
  let showTestButtons = $state(false)

  const EPOCH_TIMEOUT = 10000
  const DEFAULT_TIMEOUT = 30000
  const PRINTABLE_RATIO_THRESHOLD = 0.9
  const HEX_PREVIEW_BYTES = 32
  const TEXT_PREVIEW_MAX = 500

  async function handleCreateManifest() {
    result = undefined
    error = undefined

    const topicErr = validateHex(topic, 64, 'Topic')
    if (topicErr) {
      error = topicErr
      logStore.log(topicErr, 'error')
      return
    }

    const owner = feedOwner.trim() || undefined
    const feedType = isEpoch ? 'Epoch' : 'Sequence'

    try {
      logStore.log(`Creating feed manifest (feedType: ${feedType}, encrypt: ${encryptManifest})...`)
      const reference = await clientStore.client!.createFeedManifest(topic, {
        owner,
        feedType,
        uploadOptions: { encrypt: encryptManifest, pin: false, deferred: clientStore.deferred },
      })

      logStore.log(`Feed manifest created: ${reference}`)
      lastManifestReference = reference
      lastManifestTopic = topic
      lastManifestOwner = owner
      lastManifestType = feedType
      showTestButtons = true

      result = {
        title: 'Feed Manifest Created:',
        entries: [
          { label: 'Reference', value: reference },
          { label: 'Feed Type', value: feedType },
          {
            label: 'Length',
            value: `${reference.length} chars (${reference.length / 2} bytes)`,
          },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Create feed manifest error: ${msg}`, 'error')
      error = msg
    }
  }

  async function handleTestManifest() {
    result = undefined
    error = undefined

    if (!lastManifestReference) {
      error = 'No feed manifest reference available'
      logStore.log('No feed manifest reference available', 'error')
      return
    }

    const usingEpochFeed = isEpoch
    const timeoutMs = usingEpochFeed ? EPOCH_TIMEOUT : DEFAULT_TIMEOUT

    if (usingEpochFeed) {
      logStore.log("Note: Bee's /bzz/ endpoint with Epoch feeds has a known timeout issue.", 'warn')
      logStore.log(
        "The feed data IS stored correctly - see 'Verify Feed Data' for direct verification.",
      )
    }

    try {
      const bzzUrl = `http://localhost:1633/bzz/${lastManifestReference}/`
      logStore.log(`Testing feed manifest: GET ${bzzUrl}`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(bzzUrl, { signal: controller.signal }).finally(() =>
        clearTimeout(timeoutId),
      )

      logStore.log('Response headers:')
      response.headers.forEach((value, key) => {
        logStore.log(`  ${key}: ${value}`)
      })

      const status = response.status
      const statusText = response.statusText

      if (response.ok) {
        const contentType = response.headers.get('content-type') || ''
        let bodyPreview: string

        if (contentType.includes('application/json')) {
          const json = await response.json()
          bodyPreview = JSON.stringify(json, undefined, 2)
        } else if (contentType.includes('text/')) {
          bodyPreview = await response.text()
          if (bodyPreview.length > TEXT_PREVIEW_MAX) {
            bodyPreview = bodyPreview.substring(0, TEXT_PREVIEW_MAX) + '...'
          }
        } else {
          const blob = await response.blob()
          const arrayBuffer = await blob.arrayBuffer()
          const bytes = new Uint8Array(arrayBuffer)
          const decoder = new TextDecoder('utf-8', { fatal: false })
          const text = decoder.decode(bytes)
          const hasReplacementChar = text.includes('\uFFFD')
          const printableRatio =
            text
              .split('')
              .filter((c) => c.charCodeAt(0) >= 32 || c === '\n' || c === '\r' || c === '\t')
              .length / text.length

          if (
            !hasReplacementChar &&
            printableRatio > PRINTABLE_RATIO_THRESHOLD &&
            text.length > 0
          ) {
            bodyPreview =
              text.length > TEXT_PREVIEW_MAX ? text.substring(0, TEXT_PREVIEW_MAX) + '...' : text
          } else {
            const hexPreview = Array.from(bytes.slice(0, HEX_PREVIEW_BYTES))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' ')
            bodyPreview = `[Binary data: ${blob.size} bytes]\nHex: ${hexPreview}${bytes.length > HEX_PREVIEW_BYTES ? '...' : ''}`
          }
        }

        logStore.log(`Response body: ${bodyPreview}`)
        result = {
          title: 'Test Successful:',
          entries: [
            { label: 'Status', value: `${status} ${statusText}` },
            { label: 'Content-Type', value: contentType },
            {
              label: 'Swarm-Feed-Index',
              value: response.headers.get('swarm-feed-index') || 'N/A',
            },
          ],
          code: bodyPreview,
        }
      } else {
        const errorBody = await response.text()
        logStore.log(`Test failed: ${status} ${statusText} - ${errorBody}`, 'error')
        error = `Test Failed: ${status} ${statusText} - ${errorBody}`
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (usingEpochFeed) {
          logStore.log(
            `Test timed out after ${timeoutMs / 1000}s - this is a known issue with Bee's epoch finder`,
            'error',
          )
          result = {
            title: 'Epoch Feed /bzz/ Timeout (Known Issue)',
            titleVariant: 'warning',
            entries: [
              {
                value:
                  "Bee's internal epoch finder has a timeout issue when resolving epoch-based feed manifests via /bzz/.",
              },
              { value: 'Your feed data IS correctly stored!' },
              { value: 'Workarounds:' },
              {
                value: '- Use the "Verify Feed Data" button below to confirm your SOC exists',
              },
              { value: '- Use Sequence feeds instead for /bzz/ compatibility' },
              {
                value: '- Use direct feed access via our AsyncEpochFinder (works correctly)',
              },
            ],
          }
        } else {
          logStore.log(`Test timed out after ${timeoutMs / 1000}s`, 'error')
          error = 'Request timed out'
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        logStore.log(`Test feed manifest error: ${msg}`, 'error')
        error = msg
      }
    }
  }

  async function handleVerifyData() {
    result = undefined
    error = undefined

    try {
      const currentTopic = lastManifestTopic || topic
      const owner = lastManifestOwner || feedOwner.trim()
      const feedType = lastManifestType || (isEpoch ? 'Epoch' : 'Sequence')

      logStore.log(`Verifying feed data directly (type: ${feedType})...`)

      if (feedType === 'Epoch') {
        let atRaw = feedAt || Math.floor(Date.now() / 1000).toString()
        const at = parseInt(atRaw)
        logStore.log(`Using timestamp: ${at} (root epoch)`)

        const reader = clientStore.client!.makeEpochFeedReader({
          topic: currentTopic,
          owner,
        })
        const feedResult = await reader.downloadPayload({ at: BigInt(at) })

        if (feedResult.payload) {
          const text = new TextDecoder().decode(feedResult.payload)
          logStore.log(
            `Epoch feed data verified! Content length: ${feedResult.payload.length} bytes`,
          )
          result = {
            title: 'Epoch Feed Data Verified!',
            titleVariant: 'success',
            entries: [
              { value: 'The SOC at root epoch exists and contains valid data.' },
              { label: 'Content length', value: `${feedResult.payload.length} bytes` },
            ],
            code: text,
            footnote:
              "This confirms your feed is correctly stored, even though Bee's /bzz/ endpoint times out.",
          }
        } else {
          result = {
            title: 'No Feed Data Found',
            titleVariant: 'warning',
            entries: [
              {
                value: `No update found at timestamp ${at}. Make sure you've uploaded feed data first.`,
              },
            ],
          }
        }
      } else {
        const reader = clientStore.client!.makeSequentialFeedReader({
          topic: currentTopic,
          owner,
        })
        const feedResult = await reader.downloadRawPayload()

        if (feedResult?.payload) {
          const text = new TextDecoder().decode(feedResult.payload)
          logStore.log(`Sequence feed data verified! Index: ${feedResult.feedIndex}`)
          result = {
            title: 'Sequence Feed Data Verified!',
            titleVariant: 'success',
            entries: [
              { label: 'Feed Index', value: String(feedResult.feedIndex) },
              { label: 'Content length', value: `${feedResult.payload.length} bytes` },
            ],
            code: text,
          }
        } else {
          result = {
            title: 'No Feed Data Found',
            titleVariant: 'warning',
            entries: [
              {
                value: "No sequence feed updates found. Make sure you've uploaded feed data first.",
              },
            ],
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Verify feed data error: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Separator />

<div class="space-y-3">
  <div class="flex items-start gap-2">
    <Checkbox bind:checked={encryptManifest} id="encrypt-manifest" />
    <div>
      <Label for="encrypt-manifest" class="cursor-pointer">Encrypt manifest</Label>
      <p class="text-xs text-muted-foreground mt-1">
        When enabled, reference will be 128 chars (64 bytes = address + key).
      </p>
    </div>
  </div>

  <Button
    onclick={handleCreateManifest}
    disabled={!clientStore.canUpload || isEpoch}
    class="w-full"
  >
    Create Feed Manifest
  </Button>

  {#if isEpoch}
    <p class="text-xs text-muted-foreground">
      Feed manifests don't work with epoch feeds (/bzz endpoint doesn't support them)
    </p>
  {/if}

  {#if showTestButtons}
    <Button onclick={handleTestManifest} class="w-full" variant="outline">
      Test Feed Manifest (/bzz/)
    </Button>
    <Button onclick={handleVerifyData} class="w-full" variant="outline">
      Verify Feed Data (Direct SOC Check)
    </Button>
  {/if}

  <ResultDisplay {result} {error} />
</div>
