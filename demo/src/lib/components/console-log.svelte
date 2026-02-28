<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
	import { Button } from '$lib/components/ui/button'
	import { logStore } from '$lib/stores/log.svelte'

	let scrollContainer = $state<HTMLDivElement | undefined>(undefined)

	$effect(() => {
		if (logStore.entries.length && scrollContainer) {
			scrollContainer.scrollTop = scrollContainer.scrollHeight
		}
	})
</script>

<Card>
	<CardHeader class="flex flex-row items-center justify-between pb-3">
		<CardTitle>Console Log</CardTitle>
		<Button variant="ghost" size="sm" onclick={() => logStore.clear()}>Clear</Button>
	</CardHeader>
	<CardContent>
		<div class="h-[300px] overflow-auto rounded-md bg-[#2d2d2d] p-4" bind:this={scrollContainer}>
			{#each logStore.entries as entry, i (i)}
				<div class="mb-1 font-mono text-xs">
					<span class="text-gray-500">[{entry.time}]</span>
					<span
						class={entry.type === 'info'
							? 'text-green-500'
							: entry.type === 'error'
								? 'text-red-500'
								: 'text-orange-400'}
						class:font-bold={true}
					>
						[{entry.type.toUpperCase()}]
					</span>
					<span class="text-gray-200">{entry.message}</span>
				</div>
			{/each}
		</div>
	</CardContent>
</Card>
