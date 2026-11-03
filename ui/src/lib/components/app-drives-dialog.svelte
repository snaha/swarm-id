<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Confirm an edit that takes drives away from an app (#925), as a default
  drive change is confirmed (#958). Nothing moves with the edit: what the app
  saved stays on the drives it loses, and an app that keeps its files on one
  drive cannot follow them. So the user types a phrase rather than picking
  once, and is told what stays behind. Moving the data is out of scope: it
  would take every reference stored on a drive, which nothing records.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'

  /** What the user types to confirm, as for the default drive */
  const CONFIRM_PHRASE = 'change drives'

  interface Props {
    appName: string
    /** The names of the drives the edit takes away (`drivesTakenAway`) */
    takenAway: string[]
    /** Whether the app can still save anywhere after the edit */
    keepsAny: boolean
    onConfirm: () => void
    onCancel: () => void
  }

  let { appName, takenAway, keepsAny, onConfirm, onCancel }: Props = $props()

  let typed = $state('')
  const confirmed = $derived(typed.trim().toLowerCase() === CONFIRM_PHRASE)
  const one = $derived(takenAway.length === 1)

  function confirm() {
    if (confirmed) onConfirm()
  }
</script>

<Dialog onclose={onCancel} title="Change this app's drives">
  <div class="flex flex-col gap-1 text-sm">
    <p>
      <span class="font-medium">{appName}</span> will no longer be able to save to:
    </p>
    <ul class="list-inside list-disc">
      {#each takenAway as name, index (index)}
        <li class="truncate font-medium">{name}</li>
      {/each}
    </ul>
  </div>
  <div
    role="note"
    class="border-destructive/50 bg-destructive/10 flex flex-col gap-2 rounded-lg border p-3 text-sm"
  >
    <p class="font-medium">Nothing is copied or moved.</p>
    <p>
      What {appName} already saved stays where it is.
      {#if keepsAny}
        What it saves from now on goes to the drives it keeps.
      {:else}
        It will have no drive left, so it cannot save anything until you give it one.
      {/if}
      An app that keeps its files on one drive, such as a file manager, may not find them afterwards or
      may stop working as expected.
    </p>
    <p>
      {#if one}
        Do not remove that drive, or let it expire, while you still need what is on it: that data is
        lost with it.
      {:else}
        Do not remove those drives, or let them expire, while you still need what is on them: that
        data is lost with them.
      {/if}
    </p>
  </div>
  <div class="flex flex-col gap-1">
    <label for="confirm-app-drives" class="text-sm">
      Type <code class="bg-muted rounded px-1 py-0.5 font-medium">{CONFIRM_PHRASE}</code> to confirm
    </label>
    <Input
      id="confirm-app-drives"
      bind:value={typed}
      autocomplete="off"
      spellcheck={false}
      data-autofocus
      onkeydown={(event) => {
        if (event.key === 'Enter') confirm()
      }}
    />
  </div>
  <div class="flex w-full flex-col gap-2">
    <Button variant="destructive" class="w-full" disabled={!confirmed} onclick={confirm}>
      Change drives
    </Button>
    <Button variant="outline" class="w-full" onclick={onCancel}>Cancel</Button>
  </div>
</Dialog>
