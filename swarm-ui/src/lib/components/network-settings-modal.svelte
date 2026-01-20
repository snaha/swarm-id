<script lang="ts">
	import { z } from 'zod'
	import Button from './ui/button.svelte'
	import Modal, { type ModalProps } from './ui/modal.svelte'
	import Typography from './ui/typography.svelte'
	import Vertical from './ui/vertical.svelte'
	import Close from 'carbon-icons-svelte/lib/Close.svelte'
	import Input from './ui/input/input.svelte'
	import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
	import { DEFAULT_BEE_NODE_URL, DEFAULT_GNOSIS_RPC_URL } from '@swarm-id/lib'

	const UrlSchema = z.string().url()

	let { oncancel, open = $bindable(false), ...restProps }: ModalProps = $props()

	let beeNodeUrl = $state('')
	let gnosisRpcUrl = $state('')
	let beeNodeUrlError = $state<string | undefined>(undefined)
	let gnosisRpcUrlError = $state<string | undefined>(undefined)

	// Reset form state when modal opens
	function resetForm() {
		beeNodeUrl = networkSettingsStore.beeNodeUrl
		gnosisRpcUrl = networkSettingsStore.gnosisRpcUrl
		beeNodeUrlError = undefined
		gnosisRpcUrlError = undefined
	}

	function validateBeeNodeUrl(value: string): string | undefined {
		const result = UrlSchema.safeParse(value)
		if (!result.success) {
			return 'Please enter a valid URL'
		}
		return undefined
	}

	function validateGnosisRpcUrl(value: string): string | undefined {
		const result = UrlSchema.safeParse(value)
		if (!result.success) {
			return 'Please enter a valid URL'
		}
		return undefined
	}

	function handleBeeNodeUrlInput() {
		beeNodeUrlError = validateBeeNodeUrl(beeNodeUrl)
	}

	function handleGnosisRpcUrlInput() {
		gnosisRpcUrlError = validateGnosisRpcUrl(gnosisRpcUrl)
	}

	function handleSave() {
		// Validate both fields
		beeNodeUrlError = validateBeeNodeUrl(beeNodeUrl)
		gnosisRpcUrlError = validateGnosisRpcUrl(gnosisRpcUrl)

		if (beeNodeUrlError || gnosisRpcUrlError) {
			return
		}

		networkSettingsStore.updateSettings({
			beeNodeUrl,
			gnosisRpcUrl,
		})

		open = false
	}

	function handleReset() {
		beeNodeUrl = DEFAULT_BEE_NODE_URL
		gnosisRpcUrl = DEFAULT_GNOSIS_RPC_URL
		beeNodeUrlError = undefined
		gnosisRpcUrlError = undefined
	}

	function handleCancel() {
		open = false
		oncancel?.()
	}

	const isValid = $derived(!beeNodeUrlError && !gnosisRpcUrlError && beeNodeUrl && gnosisRpcUrl)
</script>

<Modal oncancel={handleCancel} bind:open onshow={resetForm} {...restProps}>
	<section class="dialog">
		<header class="horizontal">
			<Typography variant="h5">Network settings</Typography>
			<div class="grower"></div>
			<Button variant="ghost" dimension="compact" onclick={handleCancel}><Close size={24} /></Button
			>
		</header>

		<Vertical --vertical-gap="var(--padding)">
			<Input
				variant="outline"
				dimension="compact"
				name="bee-node-url"
				bind:value={beeNodeUrl}
				label="Bee node URL"
				placeholder={DEFAULT_BEE_NODE_URL}
				error={beeNodeUrlError}
				oninput={handleBeeNodeUrlInput}
			/>
			<Input
				variant="outline"
				dimension="compact"
				name="gnosis-rpc-url"
				bind:value={gnosisRpcUrl}
				label="Gnosis RPC endpoint"
				placeholder={DEFAULT_GNOSIS_RPC_URL}
				error={gnosisRpcUrlError}
				oninput={handleGnosisRpcUrlInput}
			/>
		</Vertical>

		<section class="buttons">
			<Button variant="strong" dimension="compact" onclick={handleSave} disabled={!isValid}
				>Save settings</Button
			>
			<Button variant="ghost" dimension="compact" onclick={handleCancel}>Cancel</Button>
			<div class="grower"></div>
			<Button variant="ghost" dimension="compact" onclick={handleReset}>Reset to defaults</Button>
		</section>
	</section>
</Modal>

<style lang="postcss">
	.dialog {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: var(--one-and-half-padding);
		background-color: var(--colors-ultra-low);
		padding: var(--one-and-half-padding);
		height: 100%;
	}
	.horizontal {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--half-padding);
	}
	.buttons {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--half-padding);
	}
	@media screen and (max-width: 624px) {
		.buttons {
			flex-direction: column-reverse;
			align-items: stretch;
		}
	}
	.grower {
		flex-grow: 1;
	}
</style>
