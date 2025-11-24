<script lang="ts">
	import AppLogo from '$lib/components/app-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'

	interface Props {
		appName: string
		appUrl: string
	}

	let { appName, appUrl }: Props = $props()
</script>

<div class="header">
	<AppLogo width={40} height={40} />
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
</style>
