<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { DEFAULT_BEE_NODE_URL, DEFAULT_GNOSIS_RPC_URL } from '@snaha/swarm-id'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

  interface Props {
    onclose: () => void
  }

  let { onclose }: Props = $props()

  let beeNodeUrl = $state(networkSettingsStore.beeNodeUrl)
  let gnosisRpcUrl = $state(networkSettingsStore.gnosisRpcUrl)

  function isUrl(value: string): boolean {
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  }

  const beeNodeUrlValid = $derived(isUrl(beeNodeUrl.trim()))
  const gnosisRpcUrlValid = $derived(isUrl(gnosisRpcUrl.trim()))
  const canSave = $derived(beeNodeUrlValid && gnosisRpcUrlValid)

  function save() {
    if (!canSave) {
      return
    }
    // Persist trimmed values; the store's schema (z.string().url()) would reject
    // a malformed value on the next load and silently revert to defaults.
    networkSettingsStore.updateSettings({
      beeNodeUrl: beeNodeUrl.trim(),
      gnosisRpcUrl: gnosisRpcUrl.trim(),
    })
    onclose()
  }

  // Fill the fields with the defaults; only persisted once the user hits Save.
  function resetToDefaults() {
    beeNodeUrl = DEFAULT_BEE_NODE_URL
    gnosisRpcUrl = DEFAULT_GNOSIS_RPC_URL
  }
</script>

<Dialog title="Network settings" {onclose}>
  <div class="flex w-full flex-col gap-2">
    <label for="bee-node-url" class="text-sm font-medium">Bee node URL</label>
    <Input
      id="bee-node-url"
      bind:value={beeNodeUrl}
      placeholder={DEFAULT_BEE_NODE_URL}
      class="font-mono"
      aria-invalid={beeNodeUrl.trim().length > 0 && !beeNodeUrlValid}
    />
    {#if beeNodeUrl.trim().length > 0 && !beeNodeUrlValid}
      <p class="text-destructive text-xs">Please enter a valid URL</p>
    {/if}
  </div>

  <div class="flex w-full flex-col gap-2">
    <label for="gnosis-rpc-url" class="text-sm font-medium">Gnosis RPC endpoint</label>
    <Input
      id="gnosis-rpc-url"
      bind:value={gnosisRpcUrl}
      placeholder={DEFAULT_GNOSIS_RPC_URL}
      class="font-mono"
      aria-invalid={gnosisRpcUrl.trim().length > 0 && !gnosisRpcUrlValid}
    />
    {#if gnosisRpcUrl.trim().length > 0 && !gnosisRpcUrlValid}
      <p class="text-destructive text-xs">Please enter a valid URL</p>
    {/if}
  </div>

  <div class="flex w-full items-center gap-2">
    <Button class="flex-1" disabled={!canSave} onclick={save}>Save settings</Button>
    <Button variant="outline" onclick={resetToDefaults}>Reset to defaults</Button>
  </div>
</Dialog>
