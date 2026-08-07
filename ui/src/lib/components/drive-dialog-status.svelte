<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Info from '@lucide/svelte/icons/info'
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
    /**
     * `notice` for an outcome that failed to finish but lost nothing — a red
     * warning there reads as damage the user then goes looking for.
     */
    tone?: 'error' | 'notice'
  }

  let {
    title,
    phase,
    pendingLabel,
    errorMessage,
    onRetry,
    onClose,
    cancellable = false,
    tone = 'error',
    successTitle = 'Payment completed!',
    successBody = '',
    errorDetails = '',
  }: Props = $props()

  let detailsOpen = $state(false)
</script>

{#if phase === 'pending'}
  <!-- Headerless while working, per the designs: the step label is the whole
       message, and there is nothing to dismiss or navigate. -->
  <Dialog onclose={onClose} dismissable={false}>
    <div class="flex flex-col items-center gap-2 py-2 text-center">
      <LoaderCircle class="size-5 animate-spin" />
      <p class="text-sm">{pendingLabel}</p>
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
      {#if tone === 'notice'}
        <Info class="text-muted-foreground mt-0.5 size-4 shrink-0" />
      {:else}
        <TriangleAlert class="text-destructive mt-0.5 size-4 shrink-0" />
      {/if}
      <p class="text-sm">{errorMessage}</p>
    </div>
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
