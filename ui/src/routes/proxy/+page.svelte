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

  import { initProxy } from '@snaha/swarm-id'

  import { busSignalingUrl } from '$lib/bus-signaling-url'

  // Account-bus signaling server (docs/Account-Bus.md). Shared with the SwarmID
  // tab's publisher, so a build cannot end up with a bus on one and not the other.
  const signalingUrl = busSignalingUrl()

  let container = $state<HTMLDivElement>()

  onMount(() => {
    const proxy = initProxy({ signalingUrl })
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
