<!--
  Copyright 2026 The Swarm Authors. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

<!--
  Shown only when storage is partitioned AND the session cannot upload.
  Partitioning alone no longer implies read-only: the connect popup hands the
  iframe the account's upload credentials, so a reconnect usually fixes this.
-->
<script lang="ts">
  import { Alert, AlertTitle, AlertDescription } from '$lib/components/ui/alert'

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const isIOS = /iPad|iPhone|iPod/.test(ua)
  const isSafariOrIOS = isIOS || (/^((?!chrome|android).)*safari/i.test(ua) && ua.length > 0)
</script>

<Alert variant="warning" class="border-2">
  <AlertTitle class="text-base font-bold">Uploads unavailable</AlertTitle>
  <AlertDescription>
    <p class="mb-3 leading-relaxed">
      This session's storage is partitioned by your browser and it did not receive upload
      credentials, so you can browse and download content but not upload.
      {#if isSafariOrIOS}
        Safari's Intelligent Tracking Prevention partitions storage between windows.
        {#if isIOS}
          All browsers on iOS use Safari's engine and are affected.
        {/if}
      {/if}
    </p>
    <p class="text-xs leading-relaxed">
      Reconnect your Swarm ID to hand this page a fresh set of credentials. If uploads stay
      unavailable, check that your account has a usable postage batch
      {#if isSafariOrIOS}
        — or disable <strong>"Prevent cross-site tracking"</strong> in Safari's Privacy settings, which
        removes the partition entirely at the cost of some browsing privacy.
      {:else}
        , and whether a privacy setting or extension is blocking third-party storage.
      {/if}
    </p>
  </AlertDescription>
</Alert>
