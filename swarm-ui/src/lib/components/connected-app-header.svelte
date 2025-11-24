<script lang="ts">
	import AppLogo from '$lib/components/app-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'

	interface Props {
		appName: string
		appUrl: string
	}

	let { appName, appUrl }: Props = $props()

	let faviconError = $state(false)
	let faviconUrl = $state<string | undefined>(undefined)

	// Extract domain from app URL for favicon fetching
	$effect(() => {
		try {
			const url = new URL(appUrl)
			const domain = url.hostname

			// Try multiple favicon sources in order of preference
			// 1. Try the direct favicon.ico from the origin
			// 2. Use Google's favicon service as fallback (more reliable, no CORS)
			faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
		} catch {
			// If URL parsing fails, don't show favicon
			faviconUrl = undefined
		}
	})

	function handleFaviconError() {
		faviconError = true
	}
</script>

<div class="header">
	{#if faviconUrl && !faviconError}
		<img src={faviconUrl} alt="{appName} favicon" class="favicon" onerror={handleFaviconError} />
	{:else}
		<AppLogo width={40} height={40} />
	{/if}
	<div class="header-text">
		<Typography variant="h4">Connect to {appName}</Typography>
		<Typography variant="small">{appUrl}</Typography>
	</div>
</div>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: var(--double-padding);
	}

	.header-text {
		display: flex;
		flex-direction: column;
	}

	.favicon {
		width: 40px;
		height: 40px;
		border-radius: 8px;
		object-fit: contain;
	}
</style>
