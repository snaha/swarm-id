<script lang="ts">
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
  } from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import ResultDisplay from './result-display.svelte'
  import type { ResultData } from './result-types'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'

  interface Props {
    encryptedRef?: string
    historyRef?: string
    publisherPubKey?: string
  }

  let {
    encryptedRef = $bindable(''),
    historyRef = $bindable(''),
    publisherPubKey = $bindable(''),
  }: Props = $props()

  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  const REFERENCE_LENGTH = 64
  const ENCRYPTED_REFERENCE_LENGTH = 128
  const COMPRESSED_PUBKEY_LENGTH = 66

  async function handleDownload() {
    result = undefined
    error = undefined
    const ref = encryptedRef.trim()
    const hist = historyRef.trim()
    const pub = publisherPubKey.trim()

    if (!ref || (ref.length !== REFERENCE_LENGTH && ref.length !== ENCRYPTED_REFERENCE_LENGTH)) {
      error = `Invalid encrypted reference (must be ${REFERENCE_LENGTH} or ${ENCRYPTED_REFERENCE_LENGTH} hex chars)`
      logStore.log('Invalid encrypted reference', 'error')
      return
    }

    if (!hist || (hist.length !== REFERENCE_LENGTH && hist.length !== ENCRYPTED_REFERENCE_LENGTH)) {
      error = `Invalid history reference (must be ${REFERENCE_LENGTH} or ${ENCRYPTED_REFERENCE_LENGTH} hex chars)`
      logStore.log('Invalid history reference', 'error')
      return
    }

    if (!pub || pub.length !== COMPRESSED_PUBKEY_LENGTH) {
      error = `Invalid publisher public key (must be ${COMPRESSED_PUBKEY_LENGTH} hex chars)`
      logStore.log('Invalid publisher public key', 'error')
      return
    }

    try {
      logStore.log('Downloading ACT data...')
      logStore.log(`Encrypted Ref: ${ref}`)
      logStore.log(`History Ref: ${hist}`)
      logStore.log(`Publisher Key: ${pub}`)

      const data = await clientStore.client!.actDownloadData(ref, hist, pub)
      const text = new TextDecoder().decode(data)

      logStore.log(`ACT Download successful! (${data.length} bytes)`)
      result = { title: 'Decrypted Data:', entries: [{ value: text }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`ACT Download failed: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Decrypt & Download</CardTitle>
    <CardDescription>
      Decryption is handled by the identity proxy — your keys are never exposed to this app.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input bind:value={encryptedRef} placeholder="Encrypted Reference (64 hex chars)" />
    <Input bind:value={historyRef} placeholder="History Reference (64 hex chars)" />
    <Input bind:value={publisherPubKey} placeholder="Publisher Public Key (66 hex chars)" />
    <Button onclick={handleDownload} disabled={!clientStore.authenticated}>
      Download ACT Data
    </Button>
    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
