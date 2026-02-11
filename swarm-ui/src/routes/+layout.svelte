<script lang="ts">
	import '../app.pcss'
	import { themeStore } from '$lib/stores/theme.svelte'

	let { children } = $props()

	// Ensure theme store is initialized
	void themeStore.preference
</script>

{@render children()}
