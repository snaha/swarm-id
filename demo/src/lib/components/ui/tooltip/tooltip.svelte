<script lang="ts">
	import type { Snippet } from 'svelte'

	interface Props {
		text: string
		children: Snippet
	}

	let { text, children }: Props = $props()

	let open = $state(false)
	let wrapper: HTMLSpanElement | undefined = $state(undefined)

	function toggle(event: MouseEvent) {
		event.stopPropagation()
		open = !open
	}

	function onClickOutside(event: MouseEvent) {
		if (!open) return
		if (wrapper && !wrapper.contains(event.target as Node)) {
			open = false
		}
	}
</script>

<svelte:document onclick={onClickOutside} />

<span class="group relative inline-flex" bind:this={wrapper}>
	<span
		role="button"
		tabindex="0"
		onclick={toggle}
		onkeydown={(e) => e.key === 'Enter' && toggle(e as unknown as MouseEvent)}
	>
		{@render children()}
	</span>
	<span
		class="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-56 -translate-x-1/2 rounded-md bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg border border-border transition-opacity duration-150 {open
			? 'opacity-100'
			: 'opacity-0 invisible group-hover:visible group-hover:opacity-100'}"
	>
		{text}
	</span>
</span>
