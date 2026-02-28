<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card'
	import { Button } from '$lib/components/ui/button'
	import { Badge } from '$lib/components/ui/badge'
	import { Checkbox } from '$lib/components/ui/checkbox'
	import { Label } from '$lib/components/ui/label'
	import { clientStore } from '$lib/stores/client.svelte'

	const isHTTP = $derived(typeof window !== 'undefined' && window.location.protocol === 'http:')
	const hasITP = $derived(
		typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
	)

	let agentSignup = $state(false)

	const connectDisabled = $derived(
		isHTTP && !hasITP && !clientStore.storageVerified && !clientStore.authenticated,
	)
</script>

<Card>
	<CardHeader>
		<CardTitle>Authentication</CardTitle>
	</CardHeader>
	<CardContent class="space-y-4">
		{#if clientStore.authenticated}
			<Badge variant="success" class="text-sm px-3 py-1">Authenticated</Badge>
		{:else}
			<Badge variant="destructive" class="text-sm px-3 py-1">Not authenticated</Badge>
		{/if}

		{#if clientStore.identity}
			<div class="rounded-md bg-muted px-3 py-2 text-sm font-mono">
				Identity: {clientStore.identity.name} ({clientStore.identity.address.slice(
					0,
					8,
				)}...{clientStore.identity.address.slice(-6)})
			</div>
		{/if}

		<div class="flex items-center gap-3">
			<span class="text-sm text-muted-foreground">Custom button:</span>
			<Button
				onclick={() => clientStore.connect({ agent: agentSignup })}
				disabled={connectDisabled}
				class="w-[200px]"
			>
				{clientStore.authenticated ? 'Disconnect' : 'Connect'}
			</Button>
			{#if connectDisabled}
				<span class="text-xs text-warning-foreground">(use iframe button first)</span>
			{/if}
		</div>

		<div class="flex items-center gap-3">
			<span class="text-sm text-muted-foreground">Iframe button:</span>
			<div id="swarm-id-button" class="w-[200px] h-[40px]"></div>
		</div>

		<div class="flex items-center gap-2">
			<Checkbox bind:checked={agentSignup} id="agent-signup" />
			<Label for="agent-signup" class="cursor-pointer">Show agent sign-up option</Label>
		</div>
	</CardContent>
</Card>
