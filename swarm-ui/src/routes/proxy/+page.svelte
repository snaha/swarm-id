<script lang="ts">
  import { onMount } from 'svelte'
  import { initProxy } from '@swarm-id/lib'

  let authButtonContainer: HTMLDivElement

  onMount(() => {
    // Initialize the proxy - it reads Bee API URL from network settings internally
    const proxy = initProxy()

    // Set the container for auth button
    if (authButtonContainer) {
      proxy.setAuthButtonContainer(authButtonContainer)
    }

    console.log('[Proxy Page] ========================================')
    console.log('[Proxy Page] Proxy page loaded successfully!')
    console.log('[Proxy Page] Location:', window.location.href)
    console.log('[Proxy Page] Hostname:', window.location.hostname)
    console.log('[Proxy Page] Proxy initialized using library')
    console.log('[Proxy Page] ========================================')
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
