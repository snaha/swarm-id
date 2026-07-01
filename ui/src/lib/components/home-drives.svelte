<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Plus from '@lucide/svelte/icons/plus'
  import Star from '@lucide/svelte/icons/star'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import type { PostageStamp } from '@snaha/swarm-id'

  import AppIcon from '$lib/components/app-icon.svelte'
  import DriveAddDialog from '$lib/components/drive-add-dialog.svelte'
  import DriveExtendDialog from '$lib/components/drive-extend-dialog.svelte'
  import DriveResizeDialog from '$lib/components/drive-resize-dialog.svelte'
  import Toast from '$lib/components/toast.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import UtilizationBar from '$lib/components/utilization-bar.svelte'
  import { describeDrive } from '$lib/drives'
  import type { Account } from '$lib/types'
  import { cn } from '$lib/utils'

  const TOAST_DURATION_MS = 4000
  const MENU_ITEM_CLASS =
    'flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted'

  interface Props {
    account: Account
  }

  let { account }: Props = $props()

  let expandedId = $state<string | undefined>(undefined)
  let openMenuId = $state<string | undefined>(undefined)
  let nameDraft = $state('')
  let addOpen = $state(false)
  let resizeDrive = $state<PostageStamp | undefined>(undefined)
  let extendDrive = $state<PostageStamp | undefined>(undefined)

  let toastMessage = $state<string | undefined>(undefined)
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  function showToast(message: string) {
    toastMessage = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastMessage = undefined), TOAST_DURATION_MS)
  }

  function toggle(batchId: string, currentName: string) {
    if (expandedId === batchId) {
      expandedId = undefined
      return
    }
    expandedId = batchId
    nameDraft = currentName
    openMenuId = undefined
  }

  function commitRename(drive: PostageStamp) {
    const trimmed = nameDraft.trim()
    if (trimmed.length > 0 && trimmed !== drive.name) {
      account.renameStamp(drive.batchID, trimmed)
      showToast('Drive renamed')
    }
  }

  function setDefault(drive: PostageStamp) {
    account.setDefaultStamp(drive.batchID)
    openMenuId = undefined
    showToast('Default drive updated')
  }

  function remove(drive: PostageStamp) {
    account.removeStamp(drive.batchID)
    openMenuId = undefined
    if (expandedId === drive.batchID.toHex()) {
      expandedId = undefined
    }
    showToast('Drive removed')
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (openMenuId && !(event.target as HTMLElement).closest('[data-drive-menu]')) {
      openMenuId = undefined
    }
  }

  function addDrive() {
    addOpen = true
  }

  function increaseSize(drive: PostageStamp) {
    resizeDrive = drive
  }
  function extendLifespan(drive: PostageStamp) {
    extendDrive = drive
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="flex w-full flex-col gap-4">
  <div class="flex flex-col gap-1">
    <p class="text-sm">Drives are prepaid storage spaces on the Swarm network.</p>
    <p class="text-muted-foreground text-sm">
      Create multiple drives to organise your data or keep it separate across apps.
    </p>
  </div>

  <Button variant="outline" size="sm" class="self-start" onclick={addDrive}>
    <Plus />
    Add drive
  </Button>

  <div class="flex items-center gap-2">
    <p class="text-sm font-bold">Your drives</p>
    <Badge>{account.stamps.length}</Badge>
  </div>

  {#if account.stamps.length === 0}
    <p class="text-muted-foreground py-8 text-center text-sm">No drives yet.</p>
  {:else}
    <div class="flex w-full flex-col gap-2">
      {#each account.stamps as drive, index (drive.batchID.toHex())}
        {@const batchKey = drive.batchID.toHex()}
        {@const d = describeDrive(drive, index)}
        {@const isDefault = account.defaultPostageStampBatchID?.equals(drive.batchID) ?? false}
        {@const isOpen = expandedId === batchKey}
        {@const lifespanAlarm = d.status === 'expires-soon' || d.status === 'expired'}
        {@const lifespanCaption =
          d.status === 'expired'
            ? 'Expired'
            : d.expiryDate
              ? `${d.timeLeftLabel} · Estimated until ${d.expiryDate}`
              : d.timeLeftLabel}
        <div class="border-border w-full overflow-hidden rounded-lg border">
          <!-- Header row: name (editable when open) + status + capacity + toggle -->
          <div class="flex items-center gap-3 px-4 py-3">
            {#if isOpen}
              <Input
                bind:value={nameDraft}
                onchange={() => commitRename(drive)}
                aria-label="Drive name"
                class="h-8 max-w-56"
              />
            {:else}
              <p class="truncate text-sm font-medium">{d.name}</p>
              {#if isDefault}
                <Badge>Default</Badge>
              {/if}
            {/if}

            <div class="flex flex-1 items-center justify-end gap-3">
              {#if d.status === 'expired'}
                <span class="text-muted-foreground text-sm whitespace-nowrap">Drive expired</span>
              {:else if d.status === 'expires-soon'}
                <Badge variant="destructive">Expires soon</Badge>
              {:else if d.timeLeftLabel}
                <span class="text-muted-foreground text-sm whitespace-nowrap">
                  {d.timeLeftLabel}
                </span>
              {/if}

              {#if d.status !== 'expired'}
                {#if d.storageFull}
                  <Badge variant="destructive">Storage full</Badge>
                {:else}
                  <span class="text-sm whitespace-nowrap">{d.sizeLabel}</span>
                  <UtilizationBar percent={d.usedPercent} />
                {/if}
              {/if}

              <Button
                variant="ghost"
                size="icon"
                class="size-7"
                aria-label={isOpen ? 'Collapse drive' : 'Expand drive'}
                aria-expanded={isOpen}
                onclick={() => toggle(batchKey, d.name)}
              >
                <ChevronsUpDown />
              </Button>
            </div>
          </div>

          {#if isOpen}
            <!-- Size -->
            <div
              class={cn(
                'border-border flex items-center gap-2 border-t px-4 py-3',
                d.storageFull ? 'bg-destructive/10' : 'bg-muted',
              )}
            >
              <div class="flex min-w-0 flex-1 flex-col">
                <p class={cn('text-sm font-medium', d.storageFull && 'text-destructive')}>Size</p>
                <p
                  class={cn(
                    'text-sm',
                    d.storageFull ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  Up to {d.sizeLabel} · {d.usedPercent}% used
                </p>
              </div>
              <Button variant="ghost" size="sm" onclick={() => increaseSize(drive)}>
                <Pencil />
                Increase size
              </Button>
            </div>

            <!-- Lifespan -->
            <div
              class={cn(
                'border-border flex items-center gap-2 border-t px-4 py-3',
                lifespanAlarm ? 'bg-destructive/10' : 'bg-muted',
              )}
            >
              <div class="flex min-w-0 flex-1 flex-col">
                <p class={cn('text-sm font-medium', lifespanAlarm && 'text-destructive')}>
                  Lifespan
                </p>
                <p
                  class={cn(
                    'text-sm',
                    lifespanAlarm ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {lifespanCaption}
                </p>
              </div>
              <Button variant="ghost" size="sm" onclick={() => extendLifespan(drive)}>
                <Pencil />
                Extend lifespan
              </Button>
            </div>

            <!-- Connected apps (account-wide; per-drive usage not yet tracked) -->
            <div class="border-border flex flex-col gap-3 border-t px-4 py-3">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">Connected apps</p>
                <Badge>{account.connectedApps.length}</Badge>
              </div>
              <p class="text-muted-foreground text-sm">Apps using storage on this drive.</p>
              {#if account.connectedApps.length === 0}
                <p class="text-muted-foreground text-sm">No connected apps yet.</p>
              {:else}
                <div class="flex flex-col gap-2.5">
                  {#each account.connectedApps as app (app.appUrl)}
                    <div class="flex items-center gap-3">
                      <AppIcon src={app.appIcon} name={app.appName} size={36} />
                      <div class="flex min-w-0 flex-1 flex-col">
                        <p class="truncate text-sm font-medium">{app.appName}</p>
                        <p class="text-muted-foreground truncate text-sm">{app.appUrl}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Footer: purchase date + overflow menu -->
            <div class="border-border flex items-center justify-between gap-2 border-t px-4 py-2">
              <p class="text-muted-foreground text-xs">Purchased on {d.purchasedOn}</p>
              <div class="relative" data-drive-menu>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  aria-label="Drive actions"
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === batchKey}
                  onclick={() => (openMenuId = openMenuId === batchKey ? undefined : batchKey)}
                >
                  <EllipsisVertical />
                </Button>
                {#if openMenuId === batchKey}
                  <div
                    role="menu"
                    tabindex="-1"
                    class="bg-popover text-popover-foreground absolute right-0 bottom-full z-50 mb-1 min-w-40 rounded-lg border p-1 shadow-md"
                  >
                    {#if !isDefault}
                      <button
                        type="button"
                        role="menuitem"
                        class={MENU_ITEM_CLASS}
                        onclick={() => setDefault(drive)}
                      >
                        <Star class="size-4 shrink-0" />
                        <span class="flex-1 whitespace-nowrap">Set as default</span>
                      </button>
                    {/if}
                    <button
                      type="button"
                      role="menuitem"
                      class={MENU_ITEM_CLASS}
                      onclick={() => remove(drive)}
                    >
                      <Trash2 class="size-4 shrink-0" />
                      <span class="flex-1 whitespace-nowrap">Remove</span>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if addOpen}
  <DriveAddDialog {account} onClose={() => (addOpen = false)} onAdded={showToast} />
{/if}

{#if resizeDrive}
  <DriveResizeDialog
    {account}
    drive={resizeDrive}
    onClose={() => (resizeDrive = undefined)}
    onUpdated={showToast}
  />
{/if}

{#if extendDrive}
  <DriveExtendDialog
    {account}
    drive={extendDrive}
    onClose={() => (extendDrive = undefined)}
    onUpdated={showToast}
  />
{/if}

<Toast message={toastMessage} />
