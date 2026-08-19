<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  import DriveDialogStatus from '$lib/components/drive-dialog-status.svelte'
  import { Button } from '$lib/components/ui/button'
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

  let busy = $state(false)
  let step = $state<OperationStep>('recording')
  let errorMessage = $state('')

  function describe(entry: PendingOperation): string {
    // The name is optional at purchase time, so fall back to the batch — the
    // drive still has to be identifiable in the sentence that offers to
    // rescue it.
    const label = entry.name.trim() || `Drive ${entry.batchId.replace(/^0x/, '').slice(0, 4)}`
    return `“${label}” was paid for, but this device never finished setting it up. Finishing costs nothing more.`
  }

  async function finish(entry: PendingOperation) {
    busy = true
    errorMessage = ''
    try {
      await resumePending({
        account,
        entry,
        journal: operationJournal,
        onStep: (next) => (step = next),
      })
    } catch (caught) {
      errorMessage = caught instanceof Error ? caught.message : 'Could not finish it.'
    } finally {
      busy = false
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
    {#if errorMessage}
      <p class="text-destructive text-xs">{errorMessage}</p>
    {/if}
    <div class="flex items-center gap-2">
      <Button size="sm" disabled={busy} onclick={() => finish(entry)}>
        {#if busy}
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
