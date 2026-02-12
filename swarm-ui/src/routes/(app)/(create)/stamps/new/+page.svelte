<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import PostageStampForm from '$lib/components/postage-stamp-form.svelte'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import routes from '$lib/routes'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { BatchId, PrivateKey } from '@ethersphere/bee-js'

	const account = $derived(sessionStore.data.account)

	let batchID = $state('')
	let depth = $state(20)
	let signerKey = $state('')
	let amount = $state(0)
	let blockNumber = $state(0)
	let submitError = $state<string | undefined>(undefined)
	let isFormDisabled = $state(true)

	function handleConfirm() {
		submitError = undefined

		if (!account) return

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
				blockNumber: 0,
				immutableFlag: false,
				exists: true,
			})

			// Set as default stamp for the account
			accountsStore.setDefaultStamp(account.id, stamp.batchID)

			// Navigate to connect or home
			if (sessionStore.data.appOrigin) {
				goto(resolve(routes.CONNECT))
			} else {
				// Clear temporary masterKey for security
				sessionStore.clearTemporaryMasterKey()
				goto(resolve(routes.HOME))
			}
		} catch (error) {
			submitError = error instanceof Error ? error.message : 'Failed to add postage stamp'
		}
	}
</script>

<CreationLayout
	title="Add postage stamp"
	onClose={() =>
		sessionStore.data.appOrigin ? goto(resolve(routes.CONNECT)) : goto(resolve(routes.HOME))}
>
	{#snippet content()}
		{#if !account}
			<Typography>No account data found. Please start from the home page.</Typography>
		{:else}
			<Typography
				>Synced accounts require a Swarm postage stamp. Paste your stamp details below to continue.</Typography
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
		{/if}
	{/snippet}

	{#snippet buttonContent()}
		{#if account}
			<Button
				variant="strong"
				dimension="compact"
				onclick={handleConfirm}
				disabled={isFormDisabled}
			>
				<Checkmark size={20} />Confirm
			</Button>
		{/if}
	{/snippet}
</CreationLayout>
