<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveLabel } from '$lib/drives'
  import { type OperationStep, resumePending } from '$lib/payment/drive-operation'
  import { describeStep } from '$lib/payment/funding-request.svelte'
  import { type PendingOperation, operationJournal } from '$lib/payment/operation-journal.svelte'
  import type { Account } from '$lib/types'

  /**
   * Drives this device paid for but never finished recording.
   *
   * Without this the money is simply gone from the user's point of view: the
   * batch exists on chain, owned by the account's signer, and appears in no
   * list — and nothing looks batches up by owner. It sits above the drive list
   * because it describes a drive missing from it.
   */
  interface Props {
    account: Account
  }

  let { account }: Props = $props()

  const unfinished = $derived(
    operationJournal.entries().filter((entry) => entry.accountId === account.id.toString()),
  )

  // Which entry is being finished, if any — one at a time, and the others'
  // buttons are disabled while it runs.
  let busyBatchId = $state<string | undefined>(undefined)
  let step = $state<OperationStep>('recording')
  // Per entry: a failure belongs under the drive it happened to, not under
  // every drive in the list.
  let errors = $state<Record<string, string>>({})

  const busy = $derived(busyBatchId !== undefined)

  function describe(entry: PendingOperation): string {
    // The name is optional at purchase time; the shared fallback names it the
    // way the drive list will once it is recorded.
    const label = driveLabel(entry.name, entry.batchId)
    // Careful not to promise the money left: the id is written down BEFORE the
    // transaction is sent, so an entry can describe a purchase that never made
    // it onto the chain.
    return `This device started buying “${label}” and never finished setting it up. If the payment went through, finishing costs nothing more — if it never did, dismiss it.`
  }

  async function finish(entry: PendingOperation) {
    busyBatchId = entry.batchId
    errors = { ...errors, [entry.batchId]: '' }
    try {
      await resumePending({
        account,
        entry,
        journal: operationJournal,
        onStep: (next) => (step = next),
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not finish it.'
      errors = { ...errors, [entry.batchId]: message }
    } finally {
      busyBatchId = undefined
    }
  }

  function dismiss(entry: PendingOperation) {
    operationJournal.clear(entry.accountId, entry.batchId)
  }
</script>

{#each unfinished as entry (entry.batchId)}
  <div class="border-border flex w-full flex-col gap-2 rounded-md border px-4 py-3">
    <div class="flex items-start gap-2">
      <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      <p class="text-sm">{describe(entry)}</p>
    </div>
    {#if errors[entry.batchId]}
      <p class="text-destructive text-xs">{errors[entry.batchId]}</p>
    {/if}
    <div class="flex items-center gap-2">
      <Button size="sm" disabled={busy} onclick={() => finish(entry)}>
        {#if busyBatchId === entry.batchId}
          <LoaderCircle class="size-4 animate-spin" />
        {/if}
        Finish setting up
      </Button>
      <!-- Only ever a way out of a banner that cannot be finished (a drive
           removed since, a chain that will not serve it). It abandons the
           record, not the money — which stays with the account's signer. -->
      <Button variant="ghost" size="sm" disabled={busy} onclick={() => dismiss(entry)}>
        Dismiss
      </Button>
    </div>
  </div>
{/each}

{#if busy}
  <DriveDialogStatus
    title="Drive"
    phase="pending"
    pendingLabel={describeStep(step, 'purchase')}
    errorMessage=""
    onRetry={() => {}}
    onClose={() => {}}
  />
{/if}
