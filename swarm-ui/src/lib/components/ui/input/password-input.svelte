<script lang="ts">
	import { ViewFilled, ViewOff } from 'carbon-icons-svelte'
	import Input, { type Props } from './input.svelte'
	import type { HTMLInputAttributes } from 'svelte/elements'
	import Button from '$lib/components/ui/button.svelte'

	let {
		value = $bindable(),
		dimension,
		onfocus,
		onblur,
		...restProps
	}: Props & Omit<HTMLInputAttributes, 'type'> = $props()

	let size: 16 | 24 | 32 = $derived(dimension === 'large' ? 32 : dimension === 'small' ? 16 : 24)
	let revealPassword = $state(false)
	let inputRef: HTMLInputElement | undefined = $state()

	function handleFocusOut(event: FocusEvent & { currentTarget: HTMLDivElement }) {
		// Check if the new focus target is still within this component
		if (!event.currentTarget.contains(event.relatedTarget as Node)) {
			// Create a properly typed focus event for the input handlers
			const inputFocusEvent = event as FocusEvent & { currentTarget: HTMLInputElement }
			onblur?.(inputFocusEvent)
		}
	}

	function handleFocusIn(event: FocusEvent & { currentTarget: HTMLDivElement }) {
		// Create a properly typed focus event for the input handlers
		const inputFocusEvent = event as FocusEvent & { currentTarget: HTMLInputElement }
		onfocus?.(inputFocusEvent)
	}
</script>

{#snippet buttons()}
	<Button
		{dimension}
		variant="ghost"
		onclick={() => {
			revealPassword = !revealPassword
			inputRef?.focus()
		}}
		>{#if revealPassword}<ViewOff {size} />{:else}<ViewFilled {size} />{/if}</Button
	>
{/snippet}

<div onfocusout={handleFocusOut} onfocusin={handleFocusIn}>
	<Input
		bind:input={inputRef}
		{dimension}
		{buttons}
		bind:value
		{...restProps}
		type={revealPassword ? 'text' : 'password'}
	/>
</div>
