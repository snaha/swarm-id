<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'
	import { Copy, Checkmark } from 'carbon-icons-svelte'

	interface Props {
		text: string
		dimension?: 'compact' | 'default' | 'large'
		variant?: 'strong' | 'secondary' | 'ghost' | 'solid' | 'darkoverlay' | 'lightoverlay'
	}

	let { text, dimension = 'compact', variant = 'ghost' }: Props = $props()

	let copied = $state(false)
	let timeoutId = $state<ReturnType<typeof setTimeout> | undefined>(undefined)
	let previousText = $state(text)

	function handleCopy(event: MouseEvent) {
		event.stopPropagation()
		navigator.clipboard.writeText(text)
		copied = true

		// Clear any existing timeout
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}

		// Reset to copy icon after 5 seconds
		timeoutId = setTimeout(() => {
			copied = false
			timeoutId = undefined
		}, 5000)
	}

	// Reset copied state when text changes
	$effect(() => {
		if (previousText !== text) {
			copied = false
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId)
				timeoutId = undefined
			}
			previousText = text
		}
	})
</script>

<Tooltip helperText="Copied!" show={copied} variant={dimension} position="top">
	<Button {dimension} {variant} onclick={handleCopy}>
		{#if copied}
			<Checkmark size={20} />
		{:else}
			<Copy size={20} />
		{/if}
	</Button>
</Tooltip>
