<script lang="ts">
	import '../app.pcss'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'

	let { children } = $props()
</script>

<div class="logo">
	<SwarmLogo fill="#242424" height={30} />
</div>

<div class="container">
	<div class="content-area">
		{@render children()}
	</div>
</div>

<style>
	.logo {
		position: fixed;
		top: 30px;
		left: 30px;
	}

	.container {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		padding: 2rem;
		background: var(--colors-ultra-low);
	}

	.content-area {
		width: 560px;
	}
</style>
