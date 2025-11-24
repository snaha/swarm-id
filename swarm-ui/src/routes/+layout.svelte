<script lang="ts">
	import '../app.pcss'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'
	import routes from '$lib/routes'

	let { children } = $props()
</script>

<div class="logo">
	<a href={routes.HOME}>
		<SwarmLogo fill="#242424" height={30} />
	</a>
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

	.logo a {
		display: flex;
		text-decoration: none;
		cursor: pointer;
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
