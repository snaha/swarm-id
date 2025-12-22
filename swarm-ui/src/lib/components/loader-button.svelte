<script lang="ts">
	import type { Props as ButtonProps } from './ui/button.svelte'
	import Button from './ui/button.svelte'
	import Loader from './ui/loader.svelte'

	type LoaderButtonProps = ButtonProps & {
		stayActive?: boolean
	}

	let {
		variant,
		dimension,
		active = $bindable(),
		busy,
		onclick,
		children,
		stayActive = true,
		...restProps
	}: LoaderButtonProps = $props()

	const loaderColor = variant === 'strong' || variant === 'darkoverlay' ? 'high' : 'low'

	function asyncTimeout(ms: number) {
		return new Promise((resolve) => {
			setTimeout(resolve, ms)
		})
	}
</script>

<Button
	{variant}
	{dimension}
	{active}
	{busy}
	onclick={async (e: MouseEvent) => {
		if (onclick) {
			type OnclickHandler = (e: MouseEvent) => unknown
			const originalOnclick = onclick as OnclickHandler
			if (active) {
				return
			}
			active = true
			busy = true
			await asyncTimeout(0)
			try {
				await originalOnclick(e)
			} finally {
				if (!stayActive) {
					active = false
					busy = false
				}
			}
		}
	}}
	{...restProps}
>
	{@render children?.()}
	{#if active}
		<div class="loader-container">
			<Loader {dimension} color={loaderColor} />
		</div>
	{/if}
</Button>

<style>
	.loader-container {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		justify-content: center;
		align-items: center;
		width: 100%;
		height: 100%;
		z-index: 1;
		background: inherit;
		border-radius: var(--border-radius);
	}
</style>
