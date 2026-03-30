<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<script lang="ts">
  import { Alert, AlertTitle, AlertDescription } from '$lib/components/ui/alert'

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const isIOS = /iPad|iPhone|iPod/.test(ua)
  const isSafariOrIOS = isIOS || (/^((?!chrome|android).)*safari/i.test(ua) && ua.length > 0)
</script>

<Alert variant="warning" class="border-2">
  <AlertTitle class="text-base font-bold">Storage Partitioned</AlertTitle>
  <AlertDescription>
    {#if isSafariOrIOS}
      <p class="mb-3 leading-relaxed">
        Safari's Intelligent Tracking Prevention (ITP) partitions storage between windows, which
        prevents this app from accessing upload credentials. You can browse and download content,
        but uploads are not available in this session.
        {#if isIOS}
          All browsers on iOS use Safari's engine and are affected by ITP.
        {/if}
      </p>
      <p class="text-xs leading-relaxed">
        {#if isIOS}
          To enable uploads, use a desktop browser such as <strong>Chrome</strong> or
          <strong>Firefox</strong>.
        {:else}
          To enable uploads, use <strong>Chrome</strong> or <strong>Firefox</strong>.
        {/if}
        Alternatively, you can disable <strong>"Prevent cross-site tracking"</strong> in Safari's Privacy
        settings, but this reduces your browsing privacy and is not recommended.
      </p>
    {:else}
      <p class="mb-3 leading-relaxed">
        Your browser's storage partitioning prevents this app from accessing upload credentials. You
        can browse and download content, but uploads are not available in this session.
      </p>
      <p class="text-xs leading-relaxed">
        This may be caused by strict privacy settings or a browser extension. Try adjusting your
        browser's privacy settings or disabling extensions that block third-party storage.
      </p>
    {/if}
  </AlertDescription>
</Alert>
