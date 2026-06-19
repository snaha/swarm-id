<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { initProxy } from '@snaha/swarm-id'
  import { postageStampContractAddress } from '$lib/constants'

  let authButtonContainer: HTMLDivElement

  onMount(() => {
    // Initialize the proxy - it reads Bee API URL from network settings
    // internally. The PostageStamp contract address comes from a build-time env
    // so on-chain stamp-TTL reads target the right chain (mainnet vs local).
    const proxy = initProxy({ postageStampContractAddress })

    // Set the container for auth button
    if (authButtonContainer) {
      proxy.setAuthButtonContainer(authButtonContainer)
    }
  })
</script>

<div class="proxy-container">
  <div bind:this={authButtonContainer} id="auth-button-container"></div>
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .proxy-container {
    width: 100%;
    height: 100vh;
    margin: 0;
    padding: 0;
  }

  #auth-button-container {
    width: 100%;
    height: 100%;
  }
</style>
