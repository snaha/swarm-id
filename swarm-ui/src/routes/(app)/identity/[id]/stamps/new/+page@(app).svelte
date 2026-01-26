<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import { page } from '$app/stores'
	import routes from '$lib/routes'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { BatchId, PrivateKey } from '@ethersphere/bee-js'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import ResponsiveLayout from '$lib/components/ui/responsive-layout.svelte'
	import FormattedNumberInput from '$lib/components/ui/input/formatted-number/input.svelte'

	const identityId = $derived($page.params.id)

	let batchID = $state('')
	let depth = $state(20)
	let signerKey = $state('')
	let amount = $state(0)
	let blockNumber = $state(0)

	// Error state for each field
	let batchIDError = $derived.by(() => {
		if (!batchID) return undefined
		if (batchID.length !== 64) return 'Stamp ID must be exactly 64 characters (hex)'
		if (!/^[0-9a-fA-F]{64}$/.test(batchID)) return 'Stamp ID must be a valid hex string'
		return undefined
	})

	let numberError = $derived.by(() => {
		if (isNaN(depth)) return 'Depth must be a number'
		if (depth < 17 || depth > 40) return 'Depth must be between 17 and 40'

		if (isNaN(amount)) return 'Amount must be a number'
		if (amount < 0) return 'Amount must be greater than 0'

		if (isNaN(blockNumber)) return 'Block number must be a number'
		if (blockNumber < 0) return 'Block number must be greater than 0'

		return undefined
	})

	let signerKeyError = $derived.by(() => {
		if (!signerKey) return undefined
		if (signerKey.length !== 64) return 'Signer key must be exactly 64 characters (hex)'
		if (!/^[0-9a-fA-F]{64}$/.test(signerKey)) return 'Signer key must be a valid hex string'
		return undefined
	})

	let isFormDisabled = $derived(
		!batchID || !depth || !!batchIDError || !!numberError || !!signerKeyError,
	)

	function handleAddStamp() {
		// Double-check validation
		if (!batchID || batchIDError || numberError || signerKeyError) {
			return
		}

		if (!identityId) return

		const identity = identitiesStore.getIdentity(identityId)
		if (!identity) return

		const accountId = identity.accountId.toHex()

		// Create the postage stamp with defaults
		const stamp = postageStampsStore.addStamp({
			accountId,
			batchID: new BatchId(batchID),
			signerKey: new PrivateKey(signerKey),
			utilization: 0,
			usable: true,
			depth,
			amount,
			bucketDepth: 16,
			blockNumber: 0,
			immutableFlag: false,
			exists: true,
		})

		console.log('✅ Postage stamp added:', stamp.batchID.toHex(), stamp)

		// If this is the first stamp for this account, make it default for this identity
		const stamps = postageStampsStore.getStampsByAccount(accountId)
		if (stamps.length === 1 && !identity.defaultPostageStampBatchID) {
			identitiesStore.setDefaultStamp(identityId, stamp.batchID)
		}

		// Navigate back to stamps page
		goto(resolve(routes.IDENTITY_STAMPS, { id: identityId }))
	}
</script>

<CreationLayout title="Add postage stamp" onClose={() => history.back()}>
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
					<FormattedNumberInput
						variant="outline"
						dimension="compact"
						name="depth"
						locale={undefined}
						bind:value={depth}
						label="Depth"
						class="flex-grow"
						min={0}
						max={255}
						step={1}
					/>
					<FormattedNumberInput
						variant="outline"
						dimension="compact"
						name="amount"
						locale={undefined}
						bind:value={amount}
						label="Amount"
						class="flex-grow"
						min={0}
						step={1}
					/>
					<FormattedNumberInput
						variant="outline"
						dimension="compact"
						name="blockNumber"
						locale={undefined}
						bind:value={blockNumber}
						label="Block number"
						class="flex-grow"
						min={0}
						step={1}
					/>
				</ResponsiveLayout>
				{#if numberError}
					<div class="error-full-width">
						<ErrorMessage>{numberError}</ErrorMessage>
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
	:global(.flex-grow) {
		flex: 1;
		min-width: 0;
	}
</style>
