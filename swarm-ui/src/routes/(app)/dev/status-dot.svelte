<script lang="ts">
	import { onMount } from 'svelte'

	const CHECK_INTERVAL_MS = 10000

	type Status = 'online' | 'offline' | 'checking'

	let { endpoint }: { endpoint: string } = $props()

	let status = $state<Status>('checking')

	const colors: Record<Status, string> = {
		online: 'var(--colors-success, #22c55e)',
		offline: 'var(--colors-error, #ef4444)',
		checking: 'var(--colors-medium, #9ca3af)',
	}

	async function checkEndpoint() {
		try {
			await fetch(endpoint, { method: 'HEAD', mode: 'no-cors' })
			status = 'online'
		} catch {
			status = 'offline'
		}
	}

	onMount(() => {
		checkEndpoint()
		const interval = setInterval(checkEndpoint, CHECK_INTERVAL_MS)
		return () => clearInterval(interval)
	})
</script>

<span
	class="status-dot"
	class:checking={status === 'checking'}
	style="background-color: {colors[status]};"
	title={status}
></span>

<style>
	.status-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.checking {
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 0.4;
		}
		50% {
			opacity: 1;
		}
	}
</style>
