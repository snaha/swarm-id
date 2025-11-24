<script lang="ts">
	let { children } = $props()
</script>

<div class="page-content">
	<div class="content-area">
		{@render children()}
	</div>
</div>

<style>
	.page-content {
		flex: 1;
		display: flex;
		justify-content: center;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		gap: var(--double-padding);
	}

	.content-area {
		max-width: 560px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		width: 100%;
	}
</style>
