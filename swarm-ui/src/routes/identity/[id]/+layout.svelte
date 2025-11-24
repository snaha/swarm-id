<script lang="ts">
	let { children } = $props()
</script>

<div class="container">
	<div class="content-area">
		{@render children()}
	</div>
</div>

<style>
	.container {
		display: flex;
		justify-content: center;
		align-items: flex-start;
		min-height: 100vh;
		padding: 2rem;
	}

	.content-area {
		width: 560px;
	}
</style>
