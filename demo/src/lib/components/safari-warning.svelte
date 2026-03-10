<script lang="ts">
  import { Alert, AlertTitle, AlertDescription } from '$lib/components/ui/alert'

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
</script>

<Alert variant="warning" class="border-2">
  <AlertTitle class="text-base font-bold">Additional Setup Required</AlertTitle>
  <AlertDescription>
    <p class="mb-3 leading-relaxed">
      Safari's cross-site tracking prevention partitions storage between windows, which prevents the
      authentication popup from communicating with this page. To use this demo in Safari, you need
      to disable cross-site tracking prevention.
    </p>
    <p class="mb-2 font-semibold">How to disable:</p>
    {#if isIOS}
      <ul class="list-disc pl-5 leading-loose mb-3">
        <li>Open <strong>Settings</strong> on your device</li>
        <li>Go to <strong>Apps</strong> &rarr; <strong>Safari</strong></li>
        <li>Toggle off <strong>"Prevent Cross-Site Tracking"</strong></li>
        <li>Return here and reload the page</li>
      </ul>
      <p class="text-xs leading-relaxed">
        On iOS, all browsers use WebKit, so this setting must be disabled regardless of which
        browser you use. Remember to re-enable <strong>"Prevent Cross-Site Tracking"</strong> when you're
        done.
      </p>
    {:else}
      <ul class="list-disc pl-5 leading-loose mb-3">
        <li>Open Safari <strong>Settings</strong> (Cmd + ,)</li>
        <li>Go to the <strong>Privacy</strong> tab</li>
        <li>Uncheck <strong>"Prevent cross-site tracking"</strong></li>
        <li>Reload this page</li>
      </ul>
      <p class="text-xs leading-relaxed">
        Alternatively, use <strong>Chrome</strong> or <strong>Firefox</strong> which do not have
        this limitation. If you prefer Safari, remember to re-enable
        <strong>"Prevent cross-site tracking"</strong> when you're done.
      </p>
    {/if}
  </AlertDescription>
</Alert>
