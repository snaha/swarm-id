<script lang="ts">
	import Modal from '$lib/components/ui/modal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import CloseLarge from 'carbon-icons-svelte/lib/CloseLarge.svelte'
	import { validateSeedPhrase, countSeedPhraseWords } from '$lib/agent-account'

	interface Props {
		open?: boolean
		onUnlock?: (seedPhrase: string) => void
		onCancel?: () => void
	}

	let { open = $bindable(false), onUnlock, onCancel }: Props = $props()

	let seedPhrase = $state('')
	let error = $state<string | undefined>(undefined)

	const wordCount = $derived(countSeedPhraseWords(seedPhrase))

	const seedPhraseValidation = $derived.by(() => {
		if (!seedPhrase.trim()) return undefined
		return validateSeedPhrase(seedPhrase)
	})

	const seedPhraseError = $derived.by(() => {
		if (!seedPhraseValidation) return undefined
		if (seedPhraseValidation.valid) return undefined
		return seedPhraseValidation.error
	})

	const isFormValid = $derived(seedPhraseValidation?.valid)

	function handleUnlock() {
		const validation = validateSeedPhrase(seedPhrase)
		if (!validation.valid) {
			error = validation.error
			return
		}

		error = undefined
		onUnlock?.(validation.phrase)
		seedPhrase = ''
		open = false
	}

	function handleClose() {
		seedPhrase = ''
		error = undefined
		onCancel?.()
		open = false
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && isFormValid) {
			event.preventDefault()
			handleUnlock()
		}
	}

	$effect(() => {
		if (open) {
			// Reset state when modal opens
			seedPhrase = ''
			error = undefined
		}
	})
</script>

<Modal bind:open>
	<Vertical --vertical-gap="var(--padding)" style="padding: var(--padding)">
		<Horizontal --horizontal-justify-content="space-between">
			<Typography variant="h5">Enter Seed Phrase</Typography>
			<Button variant="ghost" dimension="compact" onclick={handleClose}
				><CloseLarge size={20} /></Button
			>
		</Horizontal>

		<Typography
			>Enter your BIP39 seed phrase to unlock your agent account. The phrase is never stored.</Typography
		>

		<Vertical --vertical-gap="var(--quarter-padding)">
			<Horizontal --horizontal-justify-content="space-between">
				<Typography variant="small">Seed Phrase</Typography>
				<Typography variant="small" class="word-count">{wordCount} words</Typography>
			</Horizontal>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				class="seed-phrase-input"
				bind:value={seedPhrase}
				placeholder="Enter your 12 or 24 word mnemonic..."
				rows="3"
				autofocus
				onkeydown={handleKeydown}
			></textarea>
			{#if seedPhraseError}
				<ErrorMessage>{seedPhraseError}</ErrorMessage>
			{:else if seedPhraseValidation?.valid}
				<Typography variant="small" style="color: var(--colors-green)">Valid seed phrase</Typography
				>
			{/if}
		</Vertical>

		{#if error}
			<ErrorMessage>{error}</ErrorMessage>
		{/if}

		<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-justify-content="flex-end">
			<Button dimension="compact" variant="ghost" onclick={handleClose}>Cancel</Button>
			<Button dimension="compact" onclick={handleUnlock} disabled={!isFormValid}>Unlock</Button>
		</Horizontal>
	</Vertical>
</Modal>

<style>
	.seed-phrase-input {
		width: 100%;
		padding: var(--half-padding);
		border: 1px solid var(--colors-low);
		border-radius: 4px;
		font-family: var(--typography-font-family-mono);
		font-size: var(--typography-font-size-base);
		resize: vertical;
		min-height: 80px;
	}

	.seed-phrase-input:focus {
		outline: none;
		border-color: var(--colors-high);
	}

	:global(.word-count) {
		color: var(--colors-medium);
	}
</style>
