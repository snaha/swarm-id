<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Iframe proxy endpoint. dApps embed this page in a hidden iframe via the
  @snaha/swarm-id client; the library renders the auth button into the
  container and handles the postMessage protocol.
-->
<script lang="ts">
  import { onMount } from 'svelte'

  import init, { Weeb3No103 } from '@lat-murmeldjur/weeb_3'
  import { initProxy } from '@snaha/swarm-id/internal'

  import { base } from '$app/paths'

  import { busSignalingUrl } from '$lib/bus-signaling-url'

  // Account-bus signaling server (docs/Account-Bus.md). Shared with the SwarmID
  // tab's publisher, so a build cannot end up with a bus on one and not the other.
  const signalingUrl = busSignalingUrl()

  let container = $state<HTMLDivElement>()

  /** How long a fresh weeb-3 node gets to find a first peer before it is used anyway. */
  const WEEB3_READY_TIMEOUT_MS = 30_000

  /** Experimental (#306), started only when the network settings ask for it. */
  async function startWeeb3() {
    await init()
    const node = new Weeb3No103(`${base}/weeb-3/worker.js`)
    node.start()
    await node.ready(1, WEEB3_READY_TIMEOUT_MS)
    return node
  }

  onMount(() => {
    const proxy = initProxy({ signalingUrl, startWeeb3 })
    if (container) {
      proxy.setAuthButtonContainer(container)
    }
  })
</script>

<div bind:this={container} class="h-svh w-full"></div>

<style>
  /* Embedded in the dApp's page — blend in instead of painting our theme. */
  :global(body) {
    background: transparent;
    overflow: hidden;
  }
</style>
