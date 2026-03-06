<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import PostageStampForm from '$lib/components/postage-stamp-form.svelte'
	import { navigateToConnectOrHome } from '$lib/utils/navigation'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { BatchId, PrivateKey } from '@ethersphere/bee-js'

	const account = $derived(sessionStore.data.account)
	const currentIdentityId = $derived(sessionStore.data.currentIdentityId)

	let batchID = $state('')
	let depth = $state(20)
	let signerKey = $state('')
	let amount = $state(0)
	let blockNumber = $state(0)
	let submitError = $state<string | undefined>(undefined)
	let isFormDisabled = $state(true)

	function handleUseAccountStamp() {
		navigateToConnectOrHome()
	}

	function handleConfirm() {
		submitError = undefined

		if (!account || !currentIdentityId) return

		try {
			const stamp = postageStampsStore.addStamp({
				accountId: account.id.toHex(),
				batchID: new BatchId(batchID),
				signerKey: new PrivateKey(signerKey),
				utilization: 0,
				usable: true,
				depth,
				amount,
				bucketDepth: 16,
				blockNumber,
				immutableFlag: false,
				exists: true,
			})

			// Set as default stamp for the identity
			identitiesStore.setDefaultStamp(currentIdentityId, stamp.batchID)

			navigateToConnectOrHome()
		} catch (error) {
			submitError = error instanceof Error ? error.message : 'Failed to add postage stamp'
		}
	}
</script>

<CreationLayout title="Add postage stamp (for identity)" onClose={navigateToConnectOrHome}>
	{#snippet content()}
		{#if !account || !currentIdentityId}
			<Typography>No account data found. Please start from the home page.</Typography>
		{:else}
			<Vertical --vertical-gap="var(--half-padding)">
				<Typography
					>You chose to use a separate stamp for this identity. Please paste the details below to
					proceed.</Typography
				>
				<PostageStampForm
					bind:batchID
					bind:depth
					bind:amount
					bind:blockNumber
					bind:signerKey
					bind:disabled={isFormDisabled}
					{submitError}
				/>
			</Vertical>
		{/if}
	{/snippet}

	{#snippet buttonContent()}
		{#if account && currentIdentityId}
			<Button
				variant="strong"
				dimension="compact"
				onclick={handleConfirm}
				disabled={isFormDisabled}
			>
				<Checkmark size={20} />Confirm
			</Button>
			<Typography variant="small"
				>Changed your mind? <button class="alt-link" onclick={handleUseAccountStamp}
					>Use your account stamp instead</button
				>.</Typography
			>
		{/if}
	{/snippet}
</CreationLayout>

<style>
	.alt-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--colors-ultra-high);
		text-decoration: underline;
		cursor: pointer;
	}

	.alt-link:hover {
		color: var(--colors-top);
	}
</style>
