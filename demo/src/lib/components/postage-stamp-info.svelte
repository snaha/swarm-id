<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger,
	} from '$lib/components/ui/collapsible'
	import { clientStore } from '$lib/stores/client.svelte'

	let open = $state(false)
</script>

{#if clientStore.stamp}
	<Card>
		<CardHeader class="pb-3">
			<Collapsible bind:open>
				<CollapsibleTrigger
					onclick={() => (open = !open)}
					class="flex items-center gap-2 w-full text-left cursor-pointer"
				>
					<span class="text-xs transition-transform {open ? 'rotate-90' : ''}"> &#9654; </span>
					<CardTitle>Postage Stamp</CardTitle>
				</CollapsibleTrigger>

				<CollapsibleContent {open} class="pt-3">
					<CardContent class="p-0">
						<dl class="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
							<dt class="text-muted-foreground font-medium">Batch ID</dt>
							<dd class="font-mono break-all">{clientStore.stamp.batchID}</dd>
							<dt class="text-muted-foreground font-medium">Utilization</dt>
							<dd class="font-mono">{clientStore.stamp.utilization}%</dd>
							<dt class="text-muted-foreground font-medium">Usable</dt>
							<dd class="font-mono">{clientStore.stamp.usable ? 'Yes' : 'No'}</dd>
							<dt class="text-muted-foreground font-medium">Depth</dt>
							<dd class="font-mono">{clientStore.stamp.depth}</dd>
							<dt class="text-muted-foreground font-medium">Bucket Depth</dt>
							<dd class="font-mono">{clientStore.stamp.bucketDepth}</dd>
							<dt class="text-muted-foreground font-medium">Amount</dt>
							<dd class="font-mono">{clientStore.stamp.amount}</dd>
							<dt class="text-muted-foreground font-medium">Block Number</dt>
							<dd class="font-mono">{clientStore.stamp.blockNumber}</dd>
							<dt class="text-muted-foreground font-medium">Immutable</dt>
							<dd class="font-mono">{clientStore.stamp.immutableFlag ? 'Yes' : 'No'}</dd>
							<dt class="text-muted-foreground font-medium">TTL</dt>
							<dd class="font-mono">{clientStore.stamp.ttl}</dd>
						</dl>
					</CardContent>
				</CollapsibleContent>
			</Collapsible>
		</CardHeader>
	</Card>
{/if}
