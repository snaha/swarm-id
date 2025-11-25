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

	const identityId = $derived($page.params.id)

	let batchID = $state('')
	let depth = $state('20')
	let signerKey = $state('')

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
			batchID,
			utilization: 0,
			usable: true,
			depth: depthNum,
			amount: '10000000',
			bucketDepth: 16,
			blockNumber: 0,
			immutableFlag: false,
			exists: true,
		})

		console.log('✅ Postage stamp added:', stamp.batchID)

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
	description="Postage stamps can be bought at https://beeport.eth.limo/"
	onClose={() => history.back()}
>
	{#snippet content()}
		<Grid>
			<!-- Row 1 -->
			<Typography>Stamp ID</Typography>
			<div class="input-wrapper">
				<Input
					variant="outline"
					dimension="compact"
					name="batchID"
					bind:value={batchID}
					error={batchIDError}
				/>
			</div>
			{#if batchIDError}
				<div class="error-full-width">
					<ErrorMessage message={batchIDError} />
				</div>
			{/if}

			<!-- Row 2 -->
			<Typography>Depth</Typography>
			<div class="input-wrapper">
				<Input
					variant="outline"
					dimension="compact"
					name="depth"
					type="number"
					bind:value={depth}
					error={depthError}
				/>
			</div>
			{#if depthError}
				<div class="error-full-width">
					<ErrorMessage message={depthError} />
				</div>
			{/if}

			<!-- Row 3 -->
			<Typography>Signer key (optional)</Typography>
			<div class="input-wrapper">
				<Input
					variant="outline"
					dimension="compact"
					name="signerKey"
					bind:value={signerKey}
					error={signerKeyError}
				/>
			</div>
			{#if signerKeyError}
				<div class="error-full-width">
					<ErrorMessage message={signerKeyError} />
				</div>
			{/if}
		</Grid>
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
</style>
