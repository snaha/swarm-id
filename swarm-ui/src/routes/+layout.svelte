<script lang="ts">
	import '../app.pcss'
	import { page } from '$app/state'
	import { themeStore } from '$lib/stores/theme.svelte'

	let { children } = $props()

	// Ensure theme store is initialized
	void themeStore.preference
</script>

{#if page.route.id === '/proxy'}
	{@render children()}
{:else}
	<div class="page-wrapper">
		{@render children()}
	</div>
{/if}

<style>
	.page-wrapper {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		background: var(--colors-ultra-low);
	}
</style>
