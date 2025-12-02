<script lang="ts">
  import { onMount } from 'svelte';
  import { initProxy } from '@swarm-id/lib/proxy';

  let appDomain: string;
  let beeApiUrl: string;
  let authButtonContainer: HTMLDivElement;

  onMount(() => {
    // Configuration - auto-detect local vs production
    appDomain = window.__APP_DOMAIN__ || (
      window.location.hostname.includes('local')
        ? 'https://swarm-app.local:8080'
        : 'https://swarm-demo.snaha.net'
    );
    const allowedParentOrigins = [
      appDomain,
      // Add more allowed origins here
    ];

    beeApiUrl = window.__BEE_API_URL__ || 'http://localhost:1633';

    // Initialize the proxy with the library
    const proxy = initProxy({
      beeApiUrl: beeApiUrl,
      allowedOrigins: allowedParentOrigins
    });

    // Set the container for auth button
    if (authButtonContainer) {
      proxy.setAuthButtonContainer(authButtonContainer);
    }

    console.log('[Proxy Page] ========================================');
    console.log('[Proxy Page] Proxy page loaded successfully!');
    console.log('[Proxy Page] Location:', window.location.href);
    console.log('[Proxy Page] Hostname:', window.location.hostname);
    console.log('[Proxy Page] APP_DOMAIN:', appDomain);
    console.log('[Proxy Page] ALLOWED_PARENT_ORIGINS:', allowedParentOrigins);
    console.log('[Proxy Page] BEE_API_URL:', beeApiUrl);
    console.log('[Proxy Page] Proxy initialized using library');
    console.log('[Proxy Page] ========================================');
  });
</script>

<div class="proxy-container">
  <div bind:this={authButtonContainer} id="auth-button-container"></div>
</div>

<style>
  .proxy-container {
    padding: 12px;
    text-align: center;
  }
</style>