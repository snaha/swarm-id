<script lang="ts">
  import SocSection from '$lib/components/soc-section.svelte'
</script>

<div class="space-y-6">
  <div class="text-foreground">
    <h1 class="text-2xl font-bold mb-1">Single Owner Chunks (SOC)</h1>
    <p class="text-muted-foreground text-sm">
      A SOC is a signed chunk addressed by owner + identifier, giving you verifiable, deterministic
      storage. SOCs are the foundation for feeds and other higher-level primitives.
    </p>
  </div>

  <SocSection />
</div>
