<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Confirm an edit that takes drives away from an app, as a default
  drive change is confirmed (#958). Nothing moves with the edit: what the app
  saved stays on the drives it loses, and an app that keeps its files on one
  drive cannot follow them. So the user types a phrase rather than picking
  once, and is told what stays behind. Moving the data is out of scope: it
  would take every reference stored on a drive, which nothing records.
-->
<script lang="ts">
  import ConfirmPhrase from '$lib/components/confirm-phrase.svelte'
  import { Dialog } from '$lib/components/ui/dialog'

  /** What the user types to confirm, as for the default drive */
  const CONFIRM_PHRASE = 'change drives'

  interface Props {
    appName: string
    /** The names of the drives the edit takes away (`drivesTakenAway`) */
    takenAway: string[]
    /** Whether the app can still save anywhere after the edit */
    keepsAny: boolean
    /** Whether the app is left fewer drives, so this page cannot give them back */
    shrinks: boolean
    onConfirm: () => void
    onCancel: () => void
  }

  let { appName, takenAway, keepsAny, shrinks, onConfirm, onCancel }: Props = $props()

  const one = $derived(takenAway.length === 1)
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
        What it saves from now on goes to the drives it is left with.
      {:else}
        It will have no drive left, so it cannot save anything until you give it one.
      {/if}
      An app that keeps its files on one drive, such as a file manager, may not find them afterwards or
      may stop working as expected.
    </p>
    <p>
      Do not remove {one ? 'that drive' : 'those drives'}, or let {one ? 'it' : 'them'} expire, while
      you still need what is on {one ? 'it' : 'them'}: that data is lost with {one ? 'it' : 'them'}.
    </p>
    {#if shrinks}
      <p>
        You cannot give {one ? 'it' : 'them'} back from here: {appName} has to ask for
        {one ? 'it' : 'them'} again.
      </p>
    {/if}
  </div>
  <ConfirmPhrase
    id="confirm-app-drives"
    phrase={CONFIRM_PHRASE}
    onconfirm={onConfirm}
    oncancel={onCancel}
  >
    Change drives
  </ConfirmPhrase>
</Dialog>
