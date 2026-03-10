<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { clientStore } from '$lib/stores/client.svelte'

  let expanded = $state(false)
</script>

<div class="space-y-2">
  <button
    onclick={() => (expanded = !expanded)}
    class="flex w-full items-center justify-between text-left rounded-md px-2.5 py-2 transition-colors hover:bg-accent"
  >
    <div class="flex items-center gap-1.5">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-muted-foreground shrink-0 transition-transform duration-200 {expanded
          ? 'rotate-90'
          : ''}"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Stamp</span>
    </div>
    {#if clientStore.stamp}
      <Badge
        variant={clientStore.stamp.usable ? 'success' : 'destructive'}
        class="text-xs px-2 py-0.5"
      >
        {clientStore.stamp.usable ? 'Usable' : 'Unusable'}
      </Badge>
    {:else}
      <Badge variant="outline" class="text-xs px-2 py-0.5 text-muted-foreground border-border"
        >N/A</Badge
      >
    {/if}
  </button>

  {#if clientStore.stamp}
    <div class="text-xs text-muted-foreground pl-6">TTL: {clientStore.stamp.ttl}</div>
  {/if}

  {#if expanded && clientStore.stamp}
    <dl class="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1 text-xs pl-6">
      <dt class="text-muted-foreground">Batch ID</dt>
      <dd class="font-mono text-foreground break-all">{clientStore.stamp.batchID}</dd>
      <dt class="text-muted-foreground">Utilization</dt>
      <dd class="font-mono text-foreground">{clientStore.stamp.utilization}%</dd>
      <dt class="text-muted-foreground">Depth</dt>
      <dd class="font-mono text-foreground">{clientStore.stamp.depth}</dd>
      <dt class="text-muted-foreground">Bucket Depth</dt>
      <dd class="font-mono text-foreground">{clientStore.stamp.bucketDepth}</dd>
      <dt class="text-muted-foreground">Amount</dt>
      <dd class="font-mono text-foreground">{clientStore.stamp.amount}</dd>
      <dt class="text-muted-foreground">Block</dt>
      <dd class="font-mono text-foreground">{clientStore.stamp.blockNumber}</dd>
      <dt class="text-muted-foreground">Immutable</dt>
      <dd class="font-mono text-foreground">{clientStore.stamp.immutableFlag ? 'Yes' : 'No'}</dd>
    </dl>
  {/if}
</div>
