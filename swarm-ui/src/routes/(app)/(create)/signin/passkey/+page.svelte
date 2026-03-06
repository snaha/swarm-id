<script lang="ts">
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import ErrorOverlay from '$lib/components/error-overlay.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Confirmation from '$lib/components/confirmation.svelte'
	import routes from '$lib/routes'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { restoreAccountFromSwarm, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import { Bee, BatchId } from '@ethersphere/bee-js'
	import { restoreAccountToStores } from '$lib/utils/restore-account'

	let failed = $state(false)
	let isProcessing = $state(false)

	async function handleConfirmPasskey() {
		try {
			isProcessing = true
			failed = false

			const passkeyAccount = await authenticateWithPasskey()

			let account = accountsStore.accounts.find(
				(a) => a.type === 'passkey' && a.credentialId === passkeyAccount.credentialId,
			)

			if (!account) {
				// No local account — attempt to restore from Swarm
				const bee = new Bee(networkSettingsStore.beeNodeUrl)
				const result = await restoreAccountFromSwarm(
					bee,
					passkeyAccount.masterKey,
					passkeyAccount.ethereumAddress,
					passkeyAccount.credentialId,
				)

				if (!result) {
					failed = true
					isProcessing = false
					return
				}

				// Restore account to local stores
				const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(
					passkeyAccount.masterKey.toHex(),
				)

				account = restoreAccountToStores({
					account: {
						id: passkeyAccount.ethereumAddress,
						createdAt: result.snapshot.metadata.createdAt,
						name: result.snapshot.metadata.accountName ?? 'Passkey',
						type: 'passkey',
						credentialId: passkeyAccount.credentialId,
						swarmEncryptionKey,
						defaultPostageStampBatchID: result.snapshot.metadata.defaultPostageStampBatchID
							? new BatchId(result.snapshot.metadata.defaultPostageStampBatchID)
							: undefined,
					},
					identities: result.snapshot.identities,
					connectedApps: result.snapshot.connectedApps,
					postageStamps: result.snapshot.postageStamps,
				})
			}

			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(passkeyAccount.masterKey)
			goto(resolve(routes.HOME))
		} catch {
			failed = true
			isProcessing = false
		}
	}

	function handleTryAgain() {
		failed = false
		isProcessing = false
	}

	function handleClose() {
		goto(resolve(routes.HOME))
	}
</script>

{#if failed}
	<ErrorOverlay
		title="Sign in failed"
		description="Make sure you're using the same Passkey used during account creation."
		onTryAgain={handleTryAgain}
	/>
{:else if isProcessing}
	<Confirmation authenticationType="passkey" />
{:else}
	<CreationLayout title="Sign in with Passkey" onClose={handleClose}>
		{#snippet content()}
			<Typography>
				Make sure to use the same Passkey you used to create your Swarm ID account.
			</Typography>
		{/snippet}

		{#snippet buttonContent()}
			<Button dimension="compact" onclick={handleConfirmPasskey} class="mobile-full-width">
				Confirm with Passkey
				<ArrowRight size={20} />
			</Button>
		{/snippet}
	</CreationLayout>
{/if}

<style>
	@media screen and (max-width: 640px) {
		:global(.mobile-full-width) {
			width: 100%;
			justify-content: center;
		}
	}
</style>
