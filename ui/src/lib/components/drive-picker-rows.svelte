<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
<!--
  The drive rows of a grant, one select each, with "Add new drive…" opening
  the Add drive dialog for that row (#711, #885). Shared by the permissions
  popup and the app's own page; the rows are the caller's (`PickerRow[]`),
  this only renders and edits them.
-->
<script lang="ts">
  import DriveAddDialog from '$lib/components/drive-add-dialog.svelte'
  import { Select, type SelectOption } from '$lib/components/ui/select'
  import { ADD_NEW_DRIVE, type PickerRow, kindOf, rowChoices } from '$lib/drive-request'
  import { driveDisplayName } from '$lib/drives'
  import { unknownDriveLabel } from '$lib/permissions-request'
  import { toastStore } from '$lib/stores/toast.svelte'
  import type { Account } from '$lib/types'

  interface Props {
    account: Account
    rows: PickerRow[]
    /** What an empty optional row says: "Please select drive" on a request, "None" on an edit. */
    emptyLabel: string
    onchange?: () => void
  }

  let { account, rows = $bindable(), emptyLabel, onchange }: Props = $props()

  const drives = $derived(account.stamps)
  const defaultBatchHex = $derived(
    account.defaultPostageStampBatchID?.toHex() ??
      drives.find((drive) => kindOf(drive) === 'regular')?.batchID.toHex(),
  )

  let addingFor = $state<number | undefined>(undefined)
  /** Re-mounts the selects after the dialog closes (see the connect done page). */
  let selectEpoch = $state(0)
  let batchesBeforeAdd = new Set<string>()

  function optionsFor(index: number): SelectOption[] {
    const choices = rowChoices(rows, index, drives).map((drive) => ({
      value: drive.batchID.toHex(),
      label:
        driveDisplayName(drive) + (drive.batchID.toHex() === defaultBatchHex ? ' (default)' : ''),
    }))
    // A granted drive this device has no record of: keep it selectable, so
    // leaving it keeps it and "None" is the only way to drop it.
    const chosen = rows[index].chosen
    if (chosen !== '' && !choices.some((choice) => choice.value === chosen)) {
      choices.unshift({ value: chosen, label: unknownDriveLabel(chosen) })
    }
    return [
      ...(rows[index].optional ? [{ value: '', label: emptyLabel }] : []),
      ...choices,
      { value: ADD_NEW_DRIVE, label: 'Add new drive…' },
    ]
  }

  function choose(index: number, value: string) {
    if (value === ADD_NEW_DRIVE) {
      batchesBeforeAdd = new Set(drives.map((drive) => drive.batchID.toHex()))
      addingFor = index
    } else {
      rows[index].chosen = value
      onchange?.()
    }
  }

  function closeAddDialog() {
    addingFor = undefined
    selectEpoch += 1
  }

  function onDriveAdded(message: string) {
    toastStore.show(message)
    const added = drives.find((drive) => !batchesBeforeAdd.has(drive.batchID.toHex()))
    if (addingFor !== undefined && added) {
      rows[addingFor].chosen = added.batchID.toHex()
      onchange?.()
    }
  }
</script>

{#each rows as row, index (index)}
  <div class="flex w-full flex-col gap-2">
    <p class="text-sm">{row.kind === 'scratch' ? 'Scratch drive' : 'Drive'}</p>
    {#key selectEpoch}
      <Select
        options={optionsFor(index)}
        value={row.chosen}
        onchange={(value) => choose(index, value)}
      />
    {/key}
    <p class="text-muted-foreground text-sm">{row.description}</p>
  </div>
{/each}

{#if addingFor !== undefined}
  <DriveAddDialog
    {account}
    kind={rows[addingFor].kind}
    onClose={closeAddDialog}
    onAdded={onDriveAdded}
  />
{/if}
