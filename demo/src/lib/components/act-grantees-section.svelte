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
    historyRef?: string
    onHistoryUpdate?: (newHistoryRef: string) => void
  }

  let { historyRef = $bindable(''), onHistoryUpdate }: Props = $props()

  let granteesInput = $state('')
  let result = $state<ResultData | undefined>(undefined)
  let error = $state<string | undefined>(undefined)

  const REFERENCE_LENGTH = 64
  const ENCRYPTED_REFERENCE_LENGTH = 128
  const COMPRESSED_PUBKEY_LENGTH = 66

  async function handleAddGrantees() {
    result = undefined
    error = undefined
    const hist = historyRef.trim()

    if (!hist || (hist.length !== REFERENCE_LENGTH && hist.length !== ENCRYPTED_REFERENCE_LENGTH)) {
      error = `Invalid history reference (must be ${REFERENCE_LENGTH} or ${ENCRYPTED_REFERENCE_LENGTH} hex chars)`
      logStore.log('Invalid history reference', 'error')
      return
    }

    const grantees = granteesInput
      ? granteesInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    if (grantees.length === 0) {
      error = 'Please enter at least one grantee public key'
      logStore.log('No grantees specified', 'error')
      return
    }

    for (const grantee of grantees) {
      if (grantee.length !== COMPRESSED_PUBKEY_LENGTH || !/^[0-9a-fA-F]+$/.test(grantee)) {
        error = `Invalid grantee public key (must be ${COMPRESSED_PUBKEY_LENGTH} hex chars): ${grantee}`
        logStore.log(`Invalid grantee public key: ${grantee}`, 'error')
        return
      }
    }

    try {
      logStore.log(`Adding ${grantees.length} grantee(s) to ACT...`)
      logStore.log(`Current History Ref: ${hist}`)

      const addResult = await clientStore.client!.actAddGrantees(hist, grantees)

      logStore.log('Grantees added successfully!')
      logStore.log(`New History Reference: ${addResult.historyReference}`)
      logStore.log(`New ACT Reference: ${addResult.actReference}`)

      onHistoryUpdate?.(addResult.historyReference)

      result = {
        title: 'Grantees Added Successfully!',
        entries: [
          { label: 'New History Ref', value: addResult.historyReference },
          { label: 'New ACT Ref', value: addResult.actReference },
          { label: 'Grantee List Ref', value: addResult.granteeListReference },
        ],
        status: 'Use the new History Reference for future downloads/modifications',
        statusVariant: 'success',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logStore.log(`Add grantees failed: ${msg}`, 'error')
      error = msg
    }
  }
</script>

<Card>
  <CardHeader>
    <CardTitle>Manage Grantees</CardTitle>
    <CardDescription>
      Grant access to additional identities after the initial upload.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    <Input bind:value={historyRef} placeholder="Current History Reference (64 hex chars)" />
    <Input
      bind:value={granteesInput}
      placeholder="New grantee public keys (comma-separated, 66 hex chars each)"
    />
    <Button onclick={handleAddGrantees} disabled={!clientStore.canUpload}>Add Grantees</Button>
    <ResultDisplay {result} {error} />
  </CardContent>
</Card>
