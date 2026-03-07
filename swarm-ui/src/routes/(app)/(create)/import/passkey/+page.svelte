<script lang="ts">
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import { onMount } from 'svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import ErrorOverlay from '$lib/components/error-overlay.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Confirmation from '$lib/components/confirmation.svelte'
	import routes from '$lib/routes'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { navigateToConnectOrHome } from '$lib/utils/navigation'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { decryptEncryptedExport, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import { BatchId } from '@ethersphere/bee-js'
	import { restoreAccountToStores } from '$lib/utils/restore-account'

	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	const header = $derived(sessionStore.data.importHeader)
	const fileData = $derived(sessionStore.data.importFileData)

	onMount(() => {
		if (!header || !fileData || header.accountType !== 'passkey') {
			goto(resolve(routes.HOME))
		}
	})

	async function handleConfirmPasskey() {
		if (!header || header.accountType !== 'passkey' || !fileData) return

		try {
			isProcessing = true
			error = undefined

			const passkeyAccount = await authenticateWithPasskey({
				allowCredentialIds: [header.credentialId],
			})

			if (passkeyAccount.credentialId !== header.credentialId) {
				error =
					'Wrong Passkey. Make sure to use the same Passkey that was used to create this account.'
				isProcessing = false
				return
			}

			const existingAccount = accountsStore.accounts.find(
				(a) => a.type === 'passkey' && a.credentialId === passkeyAccount.credentialId,
			)
			if (existingAccount) {
				error = 'Account already exists on this device. Go back to the home screen to select it.'
				isProcessing = false
				return
			}

			const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(
				passkeyAccount.masterKey.toHex(),
			)

			const result = await decryptEncryptedExport(fileData, swarmEncryptionKey)

			if (!result.success) {
				error = 'Decryption failed. Make sure you used the correct Passkey.'
				isProcessing = false
				return
			}

			const account = restoreAccountToStores({
				account: {
					id: passkeyAccount.ethereumAddress,
					createdAt: result.data.metadata.createdAt,
					name: result.data.metadata.accountName,
					type: 'passkey',
					credentialId: passkeyAccount.credentialId,
					swarmEncryptionKey,
					defaultPostageStampBatchID: result.data.metadata.defaultPostageStampBatchID
						? new BatchId(result.data.metadata.defaultPostageStampBatchID)
						: undefined,
				},
				identities: result.data.identities,
				connectedApps: result.data.connectedApps,
				postageStamps: result.data.postageStamps,
			})

			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(passkeyAccount.masterKey)
			sessionStore.clearImportData()

			navigateToConnectOrHome()
		} catch (err) {
			console.error('🔑 Passkey import failed:', err)
			error =
				'Authentication failed. Make sure you used the same Passkey used during account creation.'
			isProcessing = false
		}
	}

	function handleTryAgain() {
		error = undefined
		isProcessing = false
	}

	function handleClose() {
		sessionStore.clearImportData()
		goto(resolve(routes.HOME))
	}
</script>

{#if error}
	<ErrorOverlay title="Sign in failed" description={error} onTryAgain={handleTryAgain} />
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
			<Button
				variant="strong"
				dimension="compact"
				onclick={handleConfirmPasskey}
				class="mobile-full-width"
			>
				Confirm with Passkey
				<ArrowRight size={20} />
			</Button>
		{/snippet}
	</CreationLayout>
{/if}
