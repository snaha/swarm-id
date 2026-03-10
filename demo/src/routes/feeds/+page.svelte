<script lang="ts">
  import FeedsSection from '$lib/components/feeds-section.svelte'
</script>

<div class="space-y-6">
  <div class="text-foreground">
    <h1 class="text-2xl font-bold mb-1">Publish & Read Feeds</h1>
    <p class="text-muted-foreground text-sm">
      Feeds give you a stable address that always resolves to the latest content you publish. Choose
      sequential feeds for ordered updates or epoch-based feeds for timestamp-indexed lookups.
    </p>
  </div>

  <FeedsSection />
</div>
