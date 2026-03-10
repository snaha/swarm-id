<script lang="ts">
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
  } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import { Separator } from '$lib/components/ui/separator'
  import ResultDisplay from './result-display.svelte'
  import type { ResultData } from './result-types'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'

  const DEFAULT_IDENTIFIER = '0000000000000000000000000000000000000000000000000000000000000000'
  const IDENTIFIER_LENGTH = 64
  const OWNER_LENGTH = 40
  const KEY_LENGTH = 64

  let identifier = $state(DEFAULT_IDENTIFIER)
  let uploadData = $state('Hello SOC!')
  let uploadResult = $state<ResultData | undefined>(undefined)
  let uploadError = $state<string | undefined>(undefined)

  let owner = $state('')
  let downloadIdentifier = $state('')
  let encryptionKey = $state('')
  let downloadResult = $state<ResultData | undefined>(undefined)
  let downloadError = $state<string | undefined>(undefined)

  async function handleEncryptedUpload() {
    uploadResult = undefined
    uploadError = undefined

    if (!clientStore.socWriter) {
      uploadError = 'SOC writer not initialized'
      logStore.log('SOC writer not initialized', 'error')
      return
    }
    if (!identifier || identifier.length !== IDENTIFIER_LENGTH) {
      uploadError = `Identifier must be ${IDENTIFIER_LENGTH} hex chars`
      logStore.log('Invalid SOC identifier', 'error')
      return
    }
    if (!uploadData) {
      uploadError = 'Please enter SOC payload'
      logStore.log('No SOC data to upload', 'error')
      return
    }

    try {
      const uint8Data = new TextEncoder().encode(uploadData)
      logStore.log('Uploading encrypted SOC...')
      const result = await clientStore.socWriter.upload(identifier, uint8Data)

      logStore.log(`SOC upload successful! Reference: ${result.reference}`)
      owner = result.owner
      downloadIdentifier = identifier
      encryptionKey = result.encryptionKey || ''

      uploadResult = {
        title: 'Encrypted SOC Upload Result:',
        entries: [
          { label: 'Reference', value: result.reference },
          { label: 'Owner', value: result.owner },
          { label: 'Encryption Key', value: result.encryptionKey || 'N/A' },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`SOC upload failed: ${msg}`, 'error')
      uploadError = msg
    }
  }

  async function handleRawUpload() {
    uploadResult = undefined
    uploadError = undefined
    encryptionKey = ''

    if (!clientStore.socWriter) {
      uploadError = 'SOC writer not initialized'
      logStore.log('SOC writer not initialized', 'error')
      return
    }
    if (!identifier || identifier.length !== IDENTIFIER_LENGTH) {
      uploadError = `Identifier must be ${IDENTIFIER_LENGTH} hex chars`
      logStore.log('Invalid SOC identifier', 'error')
      return
    }
    if (!uploadData) {
      uploadError = 'Please enter SOC payload'
      logStore.log('No SOC data to upload', 'error')
      return
    }

    try {
      const uint8Data = new TextEncoder().encode(uploadData)
      logStore.log('Uploading raw SOC...')
      const result = await clientStore.socWriter.rawUpload(identifier, uint8Data)

      logStore.log(`SOC raw upload successful! Reference: ${result.reference}`)
      owner = result.owner
      downloadIdentifier = identifier

      uploadResult = {
        title: 'Raw SOC Upload Result:',
        entries: [
          { label: 'Reference', value: result.reference },
          { label: 'Owner', value: result.owner },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`SOC raw upload failed: ${msg}`, 'error')
      uploadError = msg
    }
  }

  async function handleEncryptedDownload() {
    downloadResult = undefined
    downloadError = undefined

    if (!owner || owner.length !== OWNER_LENGTH) {
      downloadError = `Owner must be ${OWNER_LENGTH} hex chars`
      logStore.log('Invalid SOC owner', 'error')
      return
    }
    if (!downloadIdentifier || downloadIdentifier.length !== IDENTIFIER_LENGTH) {
      downloadError = `Identifier must be ${IDENTIFIER_LENGTH} hex chars`
      logStore.log('Invalid SOC identifier', 'error')
      return
    }
    if (!encryptionKey || encryptionKey.length !== KEY_LENGTH) {
      downloadError = `Encryption key must be ${KEY_LENGTH} hex chars`
      logStore.log('Missing encryption key', 'error')
      return
    }

    try {
      const reader = clientStore.client!.makeSOCReader(owner)
      logStore.log('Downloading encrypted SOC...')
      const soc = await reader.download(downloadIdentifier, encryptionKey)
      const text = new TextDecoder().decode(soc.payload)

      downloadResult = {
        title: 'Encrypted SOC Download Result:',
        entries: [
          { label: 'Owner', value: soc.owner },
          { label: 'Address', value: soc.address },
          { label: 'Payload', value: text },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`SOC download failed: ${msg}`, 'error')
      downloadError = msg
    }
  }

  async function handleRawDownload() {
    downloadResult = undefined
    downloadError = undefined

    if (!owner || owner.length !== OWNER_LENGTH) {
      downloadError = `Owner must be ${OWNER_LENGTH} hex chars`
      logStore.log('Invalid SOC owner', 'error')
      return
    }
    if (!downloadIdentifier || downloadIdentifier.length !== IDENTIFIER_LENGTH) {
      downloadError = `Identifier must be ${IDENTIFIER_LENGTH} hex chars`
      logStore.log('Invalid SOC identifier', 'error')
      return
    }

    try {
      const reader = clientStore.client!.makeSOCReader(owner)
      logStore.log('Downloading raw SOC...')
      const soc = await reader.rawDownload(downloadIdentifier)
      const text = new TextDecoder().decode(soc.payload)

      downloadResult = {
        title: 'Raw SOC Download Result:',
        entries: [
          { label: 'Owner', value: soc.owner },
          { label: 'Address', value: soc.address },
          { label: 'Payload', value: text },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`SOC raw download failed: ${msg}`, 'error')
      downloadError = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Upload & Download</CardTitle>
    <CardDescription>
      Encrypted upload returns an encryption key required for download.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    <h3 class="text-base font-semibold">Upload</h3>
    <Input bind:value={identifier} placeholder="Identifier (64 hex chars)" />
    <Textarea bind:value={uploadData} placeholder="Enter SOC payload..." rows={2} />
    <div class="flex gap-2">
      <Button onclick={handleEncryptedUpload} disabled={!clientStore.canUpload}>
        Upload Encrypted SOC
      </Button>
      <Button onclick={handleRawUpload} disabled={!clientStore.canUpload}>Upload Raw SOC</Button>
    </div>
    <ResultDisplay result={uploadResult} error={uploadError} />

    <Separator />

    <h3 class="text-base font-semibold">Download</h3>
    <Input bind:value={owner} placeholder="Owner Address (40 hex chars)" />
    <Input bind:value={downloadIdentifier} placeholder="Identifier (64 hex chars)" />
    <Input
      bind:value={encryptionKey}
      placeholder="Encryption Key (64 hex chars, required for encrypted download)"
    />
    <div class="flex gap-2">
      <Button onclick={handleEncryptedDownload} disabled={!clientStore.authenticated}>
        Download Encrypted SOC
      </Button>
      <Button onclick={handleRawDownload} disabled={!clientStore.authenticated}>
        Download Raw SOC
      </Button>
    </div>
    <ResultDisplay result={downloadResult} error={downloadError} />
  </CardContent>
</Card>
