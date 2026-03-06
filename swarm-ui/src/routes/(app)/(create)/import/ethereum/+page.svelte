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
	import { connectAndSign } from '$lib/ethereum'
	import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
	import { decryptEncryptedExport, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import { Bytes } from '@ethersphere/bee-js'
	import { restoreAccountToStores } from '$lib/utils/restore-account'

	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	const header = $derived(sessionStore.data.importHeader)
	const fileData = $derived(sessionStore.data.importFileData)

	onMount(() => {
		if (!header || !fileData || header.accountType !== 'ethereum') {
			goto(resolve(routes.HOME))
		}
	})

	async function handleConfirmEthereum() {
		if (!header || header.accountType !== 'ethereum' || !fileData) return

		try {
			isProcessing = true
			error = undefined

			const signed = await connectAndSign()

			const signedAddressHex = signed.address.toLowerCase().replace('0x', '')
			if (signedAddressHex !== header.ethereumAddress.toLowerCase()) {
				error =
					'Wrong wallet. Make sure to use the same Ethereum wallet you used to create your Swarm ID account.'
				isProcessing = false
				return
			}

			const existingAccount = accountsStore.accounts.find(
				(a) => a.type === 'ethereum' && a.ethereumAddress.toString() === signedAddressHex,
			)
			if (existingAccount) {
				error = 'Account already exists on this device. Go back to the home screen to select it.'
				isProcessing = false
				return
			}

			const encryptionSalt = new Bytes(new Uint8Array(header.encryptionSalt))
			const encryptedMasterKey = new Bytes(new Uint8Array(header.encryptedMasterKey))

			const encryptionKey = await deriveEncryptionKey(signed.publicKey, encryptionSalt)
			const masterKey = await decryptMasterKey(encryptedMasterKey, encryptionKey)

			const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(masterKey.toHex())

			const result = await decryptEncryptedExport(fileData, swarmEncryptionKey)

			if (!result.success) {
				error = 'Decryption failed. Make sure you used the correct Ethereum wallet.'
				isProcessing = false
				return
			}

			const account = restoreAccountToStores(result.data)

			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(masterKey)
			sessionStore.clearImportData()

			navigateToConnectOrHome()
		} catch (err) {
			console.error('🔑 Ethereum import failed:', err)
			error =
				'Authentication failed. Make sure you used the same Ethereum wallet used during account creation.'
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
	<Confirmation authenticationType="ethereum" />
{:else}
	<CreationLayout title="Sign in with Ethereum" onClose={handleClose}>
		{#snippet content()}
			<Typography>
				Make sure to use the same Ethereum wallet you used to create your Swarm ID account.
			</Typography>
		{/snippet}

		{#snippet buttonContent()}
			<Button
				variant="strong"
				dimension="compact"
				onclick={handleConfirmEthereum}
				class="mobile-full-width"
			>
				Confirm with wallet
				<ArrowRight size={20} />
			</Button>
		{/snippet}
	</CreationLayout>
{/if}
