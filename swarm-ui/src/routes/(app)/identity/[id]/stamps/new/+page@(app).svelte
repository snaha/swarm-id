<script lang="ts">
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import { goto } from '$app/navigation'
	import { page } from '$app/stores'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { BatchId } from '@ethersphere/bee-js'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import ResponsiveLayout from '$lib/components/ui/responsive-layout.svelte'

	const identityId = $derived($page.params.id)

	let batchID = $state('')
	let depth = $state('20')
	let signerKey = $state('')
	let amount = $state('')
	let blockNumber = $state('')

	// Error state for each field
	let batchIDError = $derived.by(() => {
		if (!batchID) return undefined
		if (batchID.length !== 64) return 'Stamp ID must be exactly 64 characters (hex)'
		if (!/^[0-9a-fA-F]{64}$/.test(batchID)) return 'Stamp ID must be a valid hex string'
		return undefined
	})

	let depthError = $derived.by(() => {
		if (!depth) return undefined
		const depthNum = parseInt(depth)
		if (isNaN(depthNum)) return 'Depth must be a number'
		if (depthNum < 0 || depthNum > 255) return 'Depth must be between 0 and 255'
		return undefined
	})

	let signerKeyError = $derived.by(() => {
		if (!signerKey) return undefined
		if (signerKey.length !== 64) return 'Signer key must be exactly 64 characters (hex)'
		if (!/^[0-9a-fA-F]{64}$/.test(signerKey)) return 'Signer key must be a valid hex string'
		return undefined
	})

	let isFormDisabled = $derived(
		!batchID || !depth || !!batchIDError || !!depthError || !!signerKeyError,
	)

	function handleAddStamp() {
		// Double-check validation
		if (!batchID || batchIDError || depthError || signerKeyError) {
			return
		}

		const depthNum = parseInt(depth)

		if (!identityId) return

		// Create the postage stamp with guestimated defaults
		const stamp = postageStampsStore.addStamp({
			identityId,
			batchID: new BatchId(batchID),
			utilization: 0,
			usable: true,
			depth: depthNum,
			amount: '10000000',
			bucketDepth: 16,
			blockNumber: 0,
			immutableFlag: false,
			exists: true,
		})

		console.log('✅ Postage stamp added:', stamp.batchID.toHex())

		// If this is the first stamp for this identity, make it default
		const identity = identitiesStore.getIdentity(identityId)
		const stamps = postageStampsStore.getStampsByIdentity(identityId)
		if (stamps.length === 1 && !identity?.defaultPostageStampBatchID) {
			identitiesStore.setDefaultStamp(identityId, stamp.batchID)
		}

		// Navigate back to stamps page
		goto(`/identity/${identityId}/stamps`)
	}
</script>

<CreationLayout
	title="Add postage stamp"
	onClose={() => history.back()}
>
	{#snippet content()}
		<Vertical>
			<!-- Row 1 -->
			<div class="input-wrapper">
				<Input
					variant="outline"
					dimension="compact"
					name="batchID"
					bind:value={batchID}
					error={batchIDError}
					label="Stamp ID"
				/>
			</div>
			{#if batchIDError}
				<div class="error-full-width">
					<ErrorMessage>{batchIDError}</ErrorMessage>
				</div>
			{/if}

			<!-- Row 2 -->
			<Vertical>
				<ResponsiveLayout --responsive-justify-content="stretch">
						<Input
							variant="outline"
							dimension="compact"
							name="depth"
							type="number"
							bind:value={depth}
							error={depthError}
							label="Depth"
							class="stamp-depth"
						/>
						<Input
							variant="outline"
							dimension="compact"
							name="amount"
							type="number"
							bind:value={amount}
							error={depthError}
							label="Amount"
						/>
						<Input
							variant="outline"
							dimension="compact"
							name="blockNumber"
							type="number"
							bind:value={blockNumber}
							error={depthError}
							label="Block number"
						/>
				</ResponsiveLayout>
				{#if depthError}
					<div class="error-full-width">
						<ErrorMessage>{depthError}</ErrorMessage>
					</div>
				{/if}
			</Vertical>

			<!-- Row 3 -->
			<div class="input-wrapper">
				<Input
					variant="outline"
					dimension="compact"
					name="signerKey"
					bind:value={signerKey}
					error={signerKeyError}
					label="Signer key"
				/>
			</div>
			{#if signerKeyError}
				<div class="error-full-width">
					<ErrorMessage>{signerKeyError}</ErrorMessage>
				</div>
			{/if}
		</Vertical>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={handleAddStamp} disabled={isFormDisabled}>
			Add postage stamp
		</Button>
	{/snippet}
</CreationLayout>

<style>
	.input-wrapper :global(.error-message) {
		display: none;
	}

	.error-full-width {
		grid-column: 1 / -1;
	}
	:global(.stamp-depth) {
		flex: 0.1;
	}
</style>
