<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Iframe proxy endpoint. dApps embed this page in a hidden iframe via the
  @snaha/swarm-id client; the library renders the storage-access auth button
  into the container and handles the postMessage protocol.
-->
<script lang="ts">
  import { onMount } from 'svelte'

  import { initProxy } from '@snaha/swarm-id'

  import { dev } from '$app/environment'

  import { env } from '$env/dynamic/public'

  // Account-bus signaling server (docs/Account-Bus.md). Baked at build time:
  // the DO deployment sets PUBLIC_BUS_SIGNALING_URL; dev uses the local server
  // from `pnpm dev`; other static hosts (GitHub Pages) run without a bus.
  const DEV_SIGNALING_URL = 'ws://localhost:5520'
  const signalingUrl = env.PUBLIC_BUS_SIGNALING_URL || (dev ? DEV_SIGNALING_URL : undefined)

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
