<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'

  /**
   * The drive dialogs' shared busy/error surface: a non-dismissable spinner
   * while a node operation or payment is in flight, and an error dialog with
   * Try again / Close. Keeping it in one place keeps the three flows' UX (and
   * their retry semantics) from drifting apart.
   */
  interface Props {
    title: string
    phase: 'pending' | 'success' | 'error'
    pendingLabel: string
    /**
     * The steps already finished, oldest first, shown ticked above the current
     * one. Not decoration: when an operation fails part-way, what has already
     * been paid for is the thing the user most needs to know, and a spinner
     * that only ever names the current step erases it.
     */
    history?: string[]
    /**
     * Shown on `success`. Worded per operation on purpose — the designed
     * "Your drive is ready to use" is a purchase ending, and would be wrong
     * after an extend.
     */
    successTitle?: string
    successBody?: string
    /**
     * The raw failure, revealed behind "View details". The message above it is
     * for the user; this is what they paste into a bug report.
     */
    errorDetails?: string
    errorMessage: string
    /** Re-enter the form; the caller decides what proceeding again means. */
    onRetry: () => void
    onClose: () => void
    /** Offer a Cancel button while pending (e.g. an abortable payment). */
    cancellable?: boolean
  }

  let {
    title,
    phase,
    pendingLabel,
    history = [],
    errorMessage,
    onRetry,
    onClose,
    cancellable = false,
    successTitle = 'Payment completed!',
    successBody = '',
    errorDetails = '',
  }: Props = $props()

  let detailsOpen = $state(false)
</script>

{#if phase === 'pending'}
  <!-- Headerless while working, per the designs: the step label is the whole
       message, so the title is still the dialog's name, just not drawn. -->
  <Dialog onclose={onClose} dismissable={false} ariaLabel={title}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm">{pendingLabel}</p>
      <!-- Under the active step, not above it: what is happening now is the
           headline, and what is already done is the reassurance beneath. -->
      {#if history.length > 0}
        <ul class="text-muted-foreground mt-1 flex w-full flex-col gap-1 text-left text-xs">
          {#each history as done, index (`${index}-${done}`)}
            <li class="flex items-center gap-2">
              <CircleCheck class="size-3.5 shrink-0 text-green-600" />
              <span>{done}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if cancellable}
      <Button variant="outline" class="w-full" onclick={onClose}>Cancel</Button>
    {/if}
  </Dialog>
{:else if phase === 'success'}
  <Dialog onclose={onClose} {title}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <CircleCheck class="size-6 text-green-600" />
      <p class="text-base font-medium">{successTitle}</p>
      {#if successBody}
        <p class="text-muted-foreground text-sm">{successBody}</p>
      {/if}
    </div>
    <Button class="w-full" onclick={onClose}>Done</Button>
  </Dialog>
{:else}
  <Dialog onclose={onClose} {title}>
    <div class="flex items-start gap-2">
      <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      <p class="text-sm">{errorMessage}</p>
    </div>
    <!-- The same ticked list the pending screen shows, and here it matters
         most: a part-way failure has to say what was already paid for. -->
    {#if history.length > 0}
      <ul class="text-muted-foreground flex w-full flex-col gap-1 text-left text-xs">
        {#each history as done, index (`${index}-${done}`)}
          <li class="flex items-center gap-2">
            <CircleCheck class="size-3.5 shrink-0 text-green-600" />
            <span>{done}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if errorDetails && errorDetails !== errorMessage}
      <button
        type="button"
        class="text-muted-foreground w-full text-left text-xs underline"
        onclick={() => (detailsOpen = !detailsOpen)}
      >
        {detailsOpen ? 'Hide details' : 'View details'}
      </button>
      {#if detailsOpen}
        <p class="bg-muted w-full rounded-md px-3 py-2 font-mono text-xs break-all">
          {errorDetails}
        </p>
      {/if}
    {/if}
    <div class="flex w-full flex-col gap-2">
      <Button class="w-full" onclick={onRetry}>Try again</Button>
      <Button variant="outline" class="w-full" onclick={onClose}>Close</Button>
    </div>
  </Dialog>
{/if}
