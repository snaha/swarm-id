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
	import { authenticateWithPasskey } from '$lib/passkey'
	import { decryptEncryptedExport, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
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

			const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(
				passkeyAccount.masterKey.toHex(),
			)

			const result = await decryptEncryptedExport(fileData, swarmEncryptionKey)

			if (!result.success) {
				error = 'Decryption failed. Make sure you used the correct Passkey.'
				isProcessing = false
				return
			}

			const account = restoreAccountToStores(result.data)

			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(passkeyAccount.masterKey)
			sessionStore.clearImportData()

			goto(resolve(routes.HOME))
		} catch {
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
