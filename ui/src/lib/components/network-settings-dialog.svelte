<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { DEFAULT_BEE_NODE_URL, DEFAULT_GNOSIS_RPC_URL, isHttpUrl } from '@snaha/swarm-id'

  import { Button } from '$lib/components/ui/button'
  import { Dialog } from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { chainIdentity, probeChainId } from '$lib/payment/chain'
  import { networkSettingsStore } from '$lib/stores/network-settings.svelte'

  interface Props {
    onclose: () => void
  }

  /**
   * The local endpoints "Use local" fills in. Two chains can be serving Gnosis
   * locally — bee-compose's cluster and the standalone snapshot — so the button
   * asks which is actually answering rather than making the user remember. The
   * cluster comes first: it also serves the Bee node, so if it is up that is
   * the environment you want.
   */
  const LOCAL_BEE_NODE_URL = 'http://localhost:1633/'
  const LOCAL_GNOSIS_RPC_URLS = ['http://localhost:9545', 'http://localhost:8545']

  let { onclose }: Props = $props()

  let beeNodeUrl = $state(networkSettingsStore.beeNodeUrl)
  let gnosisRpcUrl = $state(networkSettingsStore.gnosisRpcUrl)

  // Same http(s)-only validator the store's schema uses, so a value that saves
  // here also survives the next load (a scheme-less `localhost:1633` fails both).
  const beeNodeUrlValid = $derived(isHttpUrl(beeNodeUrl.trim()))
  const gnosisRpcUrlValid = $derived(isHttpUrl(gnosisRpcUrl.trim()))
  const canSave = $derived(beeNodeUrlValid && gnosisRpcUrlValid)
  const beeNodeUrlError = $derived(beeNodeUrl.trim().length > 0 && !beeNodeUrlValid)
  const gnosisRpcUrlError = $derived(gnosisRpcUrl.trim().length > 0 && !gnosisRpcUrlValid)

  /**
   * What is actually answering at the SAVED endpoint. Worth showing, because a
   * dev chain reports the same chain id as mainnet on purpose — so the URL is
   * otherwise the only clue, and a stale `localhost` looks exactly like the
   * real thing. Probed for the saved value rather than the field being edited,
   * so typing a URL does not fire a request per keystroke.
   */
  const connected = chainIdentity(networkSettingsStore.gnosisRpcUrl).then(
    (identity) =>
      identity.isMainnet
        ? { label: 'Gnosis Chain', tone: 'text-muted-foreground' }
        : { label: 'Gnosis Chain (fake) — funds here are not real', tone: 'font-medium' },
    () => ({ label: 'Not reachable', tone: 'text-destructive' }),
  )

  function save() {
    if (!canSave) {
      return
    }
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

  /**
   * Point at whichever local chain is running. Dev builds only — the button is
   * not rendered otherwise, and typing two localhost URLs by hand is the step
   * that most often goes wrong when setting the environment up.
   */
  async function useLocal() {
    beeNodeUrl = LOCAL_BEE_NODE_URL
    const reachable = await Promise.all(
      LOCAL_GNOSIS_RPC_URLS.map((url) =>
        probeChainId(url).then(
          () => url,
          () => undefined,
        ),
      ),
    )
    gnosisRpcUrl = reachable.find((url) => url !== undefined) ?? LOCAL_GNOSIS_RPC_URLS[0]
  }
</script>

<Dialog title="Network settings" {onclose}>
  <div class="flex w-full flex-col gap-2">
    <label for="bee-node-url" class="text-sm font-medium">Bee address</label>
    <Input
      id="bee-node-url"
      bind:value={beeNodeUrl}
      placeholder={DEFAULT_BEE_NODE_URL}
      class="font-mono"
      aria-invalid={beeNodeUrlError}
    />
    {#if beeNodeUrlError}
      <p class="text-destructive text-xs">Please enter a valid URL</p>
    {/if}
  </div>

  <div class="flex w-full flex-col gap-2">
    <label for="gnosis-rpc-url" class="text-sm font-medium">RPC endpoint</label>
    <Input
      id="gnosis-rpc-url"
      bind:value={gnosisRpcUrl}
      placeholder={DEFAULT_GNOSIS_RPC_URL}
      class="font-mono"
      aria-invalid={gnosisRpcUrlError}
    />
    {#if gnosisRpcUrlError}
      <p class="text-destructive text-xs">Please enter a valid URL</p>
    {:else}
      {#await connected then chain}
        <p class="text-xs {chain.tone}">Connected to: {chain.label}</p>
      {/await}
    {/if}
  </div>

  <div class="flex w-full items-center gap-2">
    <Button disabled={!canSave} onclick={save}>Save</Button>
    <Button variant="outline" onclick={onclose}>Cancel</Button>
    {#if import.meta.env.DEV}
      <Button variant="ghost" class="ml-auto" onclick={useLocal}>Use local</Button>
      <Button variant="ghost" onclick={resetToDefaults}>Reset</Button>
    {:else}
      <Button variant="ghost" class="ml-auto" onclick={resetToDefaults}>Reset</Button>
    {/if}
  </div>
</Dialog>
