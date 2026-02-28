<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert'

	interface Props {
		result?: string
		error?: string
		class?: string
	}

	let { result, error, class: className }: Props = $props()
</script>

{#if error}
	<Alert variant="destructive" class={className}>
		<AlertDescription>
			<strong>Error:</strong>
			{error}
		</AlertDescription>
	</Alert>
{:else if result}
	<Alert class={className}>
		<AlertDescription>
			<div class="font-mono text-xs break-all whitespace-pre-wrap">
				{result}
			</div>
		</AlertDescription>
	</Alert>
{/if}
