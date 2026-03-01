<script lang="ts">
	import { Button } from '$lib/components/ui/button'
	import { Checkbox } from '$lib/components/ui/checkbox'
	import { Label } from '$lib/components/ui/label'
	import { Separator } from '$lib/components/ui/separator'
	import { Popover } from '$lib/components/ui/popover'
	import { clientStore } from '$lib/stores/client.svelte'

	const isHTTP = $derived(typeof window !== 'undefined' && window.location.protocol === 'http:')
	const hasITP = $derived(
		typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
	)

	let agentSignup = $state(false)
	let popoverOpen = $state(false)

	const connectDisabled = $derived(
		isHTTP && !hasITP && !clientStore.storageVerified && !clientStore.authenticated,
	)

	// Close popover when auth state changes (covers iframe button connect/disconnect)
	let prevAuth = $state(clientStore.authenticated)
	$effect(() => {
		const auth = clientStore.authenticated
		if (auth !== prevAuth) {
			prevAuth = auth
			popoverOpen = false
		}
	})
</script>

<Popover bind:open={popoverOpen}>
	{#snippet trigger()}
		{#if clientStore.authenticated && clientStore.identity}
			<button
				class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent"
				onclick={() => (popoverOpen = !popoverOpen)}
			>
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium text-foreground truncate">
						{clientStore.identity.name}
					</div>
					<div class="text-xs font-mono text-muted-foreground truncate">
						{clientStore.identity.address.slice(0, 6)}...{clientStore.identity.address.slice(-4)}
					</div>
				</div>
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
					class="text-muted-foreground shrink-0 transition-transform duration-200 {popoverOpen
						? 'rotate-180'
						: ''}"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</button>
		{:else}
			<Button class="w-full" size="sm" onclick={() => (popoverOpen = !popoverOpen)}
				>Connect Swarm ID</Button
			>
		{/if}
	{/snippet}

	<div class="space-y-3">
		<!-- Library API section -->
		<div>
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wider"
				>Library API</span
			>
			<p class="text-xs text-muted-foreground mt-1">
				Calls <code class="text-foreground">client.connect()</code> from the Swarm ID library. Opens a
				popup window to the identity provider where you authenticate. The popup writes your session to
				localStorage, which the embedded iframe (same origin) picks up via a storage event.
			</p>
			<Button
				onclick={() => {
					clientStore.connect({ agent: agentSignup })
					popoverOpen = false
				}}
				disabled={connectDisabled}
				size="sm"
				class="w-full mt-2"
			>
				{clientStore.authenticated ? 'Disconnect' : 'Connect'}
			</Button>
			{#if connectDisabled}
				<p class="text-xs text-muted-foreground mt-1.5">
					Disabled because your browser cannot verify cross-site storage access yet. Use the iframe
					button below to authenticate first.
				</p>
			{/if}
		</div>

		<Separator />

		<!-- Iframe button section -->
		<div>
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wider"
				>Iframe button</span
			>
			<p class="text-xs text-muted-foreground mt-1">
				This button is rendered by the Swarm ID app inside a hidden iframe. Clicking it prompts the
				browser to grant cross-site storage access via the Storage Access API, which is needed when
				the browser blocks it by default (e.g. HTTP on Chrome).
			</p>
			<div id="swarm-id-button" class="w-full h-[36px] mt-2"></div>
		</div>

		{#if !clientStore.authenticated}
			<Separator />

			<!-- Agent sign-up -->
			<div class="flex items-center gap-2">
				<Checkbox bind:checked={agentSignup} id="popover-agent-signup" />
				<Label for="popover-agent-signup" class="cursor-pointer text-xs text-muted-foreground">
					Agent sign-up
				</Label>
			</div>
		{/if}
	</div>
</Popover>
