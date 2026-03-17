<script lang="ts">
  import { Alert, AlertTitle, AlertDescription } from '$lib/components/ui/alert'
</script>

<Alert variant="warning" class="border-2">
  <AlertTitle class="text-base font-bold">Read-Only Mode</AlertTitle>
  <AlertDescription>
    <p class="mb-3 leading-relaxed">
      Safari's tracking protection prevents this app from accessing upload credentials. You can
      browse and download content, but uploads are not available in this session.
    </p>
    <p class="text-xs leading-relaxed">
      To enable uploads, use <strong>Chrome</strong> or <strong>Firefox</strong>, or disable
      <strong>"Prevent cross-site tracking"</strong> in Safari's Privacy settings.
    </p>
  </AlertDescription>
</Alert>
