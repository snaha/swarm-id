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

  let container = $state<HTMLDivElement>()

  onMount(() => {
    const proxy = initProxy()
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
