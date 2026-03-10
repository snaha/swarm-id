<script lang="ts">
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
  } from '$lib/components/ui/card'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Label } from '$lib/components/ui/label'
  import type { ResultData } from './result-types'
  import ResultDisplay from './result-display.svelte'
  import { clientStore } from '$lib/stores/client.svelte'
  import { logStore } from '$lib/stores/log.svelte'

  interface Props {
    onUploadResult?: (result: {
      encryptedReference: string
      historyReference: string
      publisherPubKey: string
    }) => void
  }

  let { onUploadResult }: Props = $props()

  let data = $state('Secret message for ACT test!')
  let granteesInput = $state('')
  let beeCompatible = $state(true)
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  const COMPRESSED_PUBKEY_LENGTH = 66

  async function handleUpload() {
    result = undefined
    error = undefined

    if (!data) {
      error = 'Please enter data to upload'
      logStore.log('No data to upload', 'error')
      return
    }

    const grantees = granteesInput
      ? granteesInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    for (const grantee of grantees) {
      if (grantee.length !== COMPRESSED_PUBKEY_LENGTH || !/^[0-9a-fA-F]+$/.test(grantee)) {
        error = `Invalid grantee public key (must be ${COMPRESSED_PUBKEY_LENGTH} hex chars): ${grantee}`
        logStore.log(`Invalid grantee public key: ${grantee}`, 'error')
        return
      }
    }

    try {
      logStore.log(`Uploading with ACT (${grantees.length} grantees)...`)
      const encoder = new TextEncoder()
      const uint8Data = encoder.encode(data)

      const actResult = await clientStore.client!.actUploadData(uint8Data, grantees, {
        deferred: clientStore.deferred,
        beeCompatible,
      })

      logStore.log('ACT Upload successful!')
      logStore.log(`Encrypted Reference: ${actResult.encryptedReference}`)
      logStore.log(`History Reference: ${actResult.historyReference}`)
      logStore.log(`Publisher Key: ${actResult.publisherPubKey}`)
      logStore.log(`ACT Reference: ${actResult.actReference}`)

      onUploadResult?.({
        encryptedReference: actResult.encryptedReference,
        historyReference: actResult.historyReference,
        publisherPubKey: actResult.publisherPubKey,
      })

      result = {
        title: 'ACT Upload Result:',
        entries: [
          { label: 'Encrypted Ref', value: actResult.encryptedReference },
          { label: 'History Ref', value: actResult.historyReference },
          { label: 'Publisher Key', value: actResult.publisherPubKey },
          { label: 'ACT Ref', value: actResult.actReference },
          { label: 'Grantee List Ref', value: actResult.granteeListReference },
        ],
        ...(beeCompatible
          ? {
              code: `curl "http://localhost:1633/bzz/${actResult.encryptedReference}/" \\
  -H "Swarm-Act: true" \\
  -H "Swarm-Act-Publisher: ${actResult.publisherPubKey}" \\
  -H "Swarm-Act-History-Address: ${actResult.historyReference}"`,
              codeDark: true,
              status: 'To download with Bee node (curl):',
              statusVariant: 'success' as const,
            }
          : {
              status:
                'Bee node download disabled: use the ACT Download section (client-side decrypt).',
              statusVariant: 'warning' as const,
            }),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`ACT Upload failed: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Upload Encrypted</CardTitle>
    <CardDescription>
      Only grantees (and the publisher) can decrypt the uploaded content.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    <Textarea bind:value={data} placeholder="Enter secret data to upload..." rows={3} />
    <Input
      bind:value={granteesInput}
      placeholder="Grantee public keys (comma-separated, 66 hex chars each)"
    />
    <p class="text-xs text-muted-foreground">
      Get Bee node's public key:
      <code class="bg-muted px-1 rounded"
        >curl -s http://localhost:1633/addresses | jq -r '.publicKey'</code
      >
    </p>

    <div class="flex items-start gap-2">
      <Checkbox bind:checked={beeCompatible} id="bee-compat" />
      <Label for="bee-compat" class="cursor-pointer text-sm text-muted-foreground">
        Bee-compatible ACT (enable Bee node /bzz download with ACT headers)
      </Label>
    </div>

    <Button onclick={handleUpload} disabled={!clientStore.canUpload}>Upload with ACT</Button>
    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
