<script lang="ts">
	import Modal from '$lib/components/ui/modal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'
	import CloseLarge from 'carbon-icons-svelte/lib/CloseLarge.svelte'
	import Upload from 'carbon-icons-svelte/lib/Upload.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import routes from '$lib/routes'
	import { layoutStore } from '$lib/stores/layout.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { connectAndSign } from '$lib/ethereum'
	import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
	import { parseEncryptedExportHeader } from '@swarm-id/lib'

	interface Props {
		open: boolean
		onclose: () => void
	}

	let { open = $bindable(), onclose }: Props = $props()

	let failedAuthMethod = $state<'ethereum' | 'passkey' | 'import-exists' | undefined>(undefined)
	let isProcessing = $state(false)
	let fileError = $state<string | undefined>(undefined)
	let isDragging = $state(false)
	let fileInputRef = $state<HTMLInputElement | undefined>(undefined)

	const errorTitle = $derived(
		failedAuthMethod === 'import-exists' ? 'Account already exists' : 'Sign in failed',
	)

	const errorDescription = $derived.by(() => {
		switch (failedAuthMethod) {
			case 'ethereum':
				return "Make sure you're using the correct wallet and secret seed combination used during account creation."
			case 'passkey':
				return "Make sure you're using the same Passkey used during account creation."
			case 'import-exists':
				return 'This account is already on this device. You can sign in directly using your Passkey or Ethereum wallet.'
			default:
				return ''
		}
	})

	function close() {
		failedAuthMethod = undefined
		isProcessing = false
		onclose()
	}

	function handleTryAgain() {
		failedAuthMethod = undefined
		isProcessing = false
	}

	async function handlePasskeyClick() {
		try {
			isProcessing = true
			failedAuthMethod = undefined

			const passkeyAccount = await authenticateWithPasskey()

			const account = accountsStore.accounts.find(
				(a) => a.type === 'passkey' && a.credentialId === passkeyAccount.credentialId,
			)

			if (!account) {
				failedAuthMethod = 'passkey'
				return
			}

			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(passkeyAccount.masterKey)
			goto(resolve(routes.HOME))
		} catch {
			failedAuthMethod = 'passkey'
		}
	}

	async function handleEthereumClick() {
		try {
			isProcessing = true
			failedAuthMethod = undefined

			const signed = await connectAndSign()

			const account = accountsStore.accounts.find(
				(a) =>
					a.type === 'ethereum' && a.ethereumAddress.toString() === signed.address.toLowerCase(),
			)

			if (!account || account.type !== 'ethereum') {
				failedAuthMethod = 'ethereum'
				return
			}

			const encryptionKey = await deriveEncryptionKey(signed.publicKey, account.encryptionSalt)
			const masterKey = await decryptMasterKey(account.encryptedMasterKey, encryptionKey)

			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(masterKey)
			goto(resolve(routes.HOME))
		} catch {
			failedAuthMethod = 'ethereum'
		}
	}

	function handleLocalAccountClick() {
		fileError = undefined
		fileInputRef?.click()
	}

	async function processImportFile(file: File) {
		try {
			fileError = undefined
			const text = await file.text()
			const fileData: unknown = JSON.parse(text)
			const result = parseEncryptedExportHeader(fileData)

			if (!result.success) {
				fileError = 'Invalid .swarmid file'
				return
			}

			const existingAccount = accountsStore.accounts.find(
				(a) => a.id.toHex() === result.header.accountId,
			)
			if (existingAccount) {
				failedAuthMethod = 'import-exists'
				return
			}

			sessionStore.setImportData(fileData, result.header)

			if (result.header.accountType === 'passkey') {
				close()
				goto(resolve(routes.IMPORT_PASSKEY))
			} else if (result.header.accountType === 'ethereum') {
				close()
				goto(resolve(routes.IMPORT_ETHEREUM))
			} else {
				fileError = `Import for ${result.header.accountType} accounts is not yet supported`
			}
		} catch {
			fileError = 'Could not read file. Make sure it is a valid .swarmid file.'
		}
	}

	function handleFileSelected(event: Event) {
		const input = event.target as HTMLInputElement
		const file = input.files?.[0]
		if (file) {
			processImportFile(file)
		}
		// Reset input so the same file can be selected again
		input.value = ''
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault()
		isDragging = true
	}

	function handleDragLeave() {
		isDragging = false
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault()
		isDragging = false
		const file = event.dataTransfer?.files[0]
		if (file) {
			processImportFile(file)
		}
	}
</script>

<input
	type="file"
	accept=".swarmid"
	class="hidden-file-input"
	bind:this={fileInputRef}
	onchange={handleFileSelected}
/>

{#if failedAuthMethod}
	<div class="error-overlay">
		<div class="error-logo">
			<SwarmLogo fill="var(--colors-ultra-high)" height={30} />
		</div>
		<div class="error-content">
			<Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
				<Vertical --vertical-gap="var(--half-padding)">
					<Typography variant="h4" center>‼️ {errorTitle}</Typography>
					<Typography center>{errorDescription}</Typography>
				</Vertical>
				<Button variant="strong" onclick={handleTryAgain}>Try again</Button>
			</Vertical>
		</div>
	</div>
{:else if layoutStore.mobile}
	{#if open}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="mobile-overlay"
			class:dragging={isDragging}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			<div class="mobile-header">
				<Typography variant="h4">Sign in</Typography>
				<Button variant="ghost" dimension="compact" onclick={close} disabled={isProcessing}>
					<CloseLarge size={20} />
				</Button>
			</div>
			<div class="mobile-content">
				<Vertical --vertical-gap="var(--half-padding)">
					<Typography>
						Select your synced account type below to sign in, or import a local account from a file.
					</Typography>
					{#if fileError}
						<ErrorMessage>{fileError}</ErrorMessage>
					{/if}
				</Vertical>
			</div>
			<Vertical class="mobile-buttons" --vertical-gap="var(--half-padding)">
				<Button variant="strong" onclick={handleEthereumClick} disabled={isProcessing} flexGrow>
					<EthereumLogo width={20} height={20} />
					Ethereum
				</Button>
				<Button variant="strong" onclick={handlePasskeyClick} disabled={isProcessing} flexGrow>
					<PasskeyLogo width={20} height={20} />
					Passkey
				</Button>
				<Button variant="ghost" onclick={handleLocalAccountClick} disabled={isProcessing} flexGrow>
					<Upload size={20} />
					Local account
				</Button>
			</Vertical>
		</div>
	{/if}
{:else}
	<Modal bind:open oncancel={close}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-drop-zone"
			class:dragging={isDragging}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			<Vertical --vertical-gap="var(--padding)" style="padding: var(--double-padding)">
				<Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
					<Typography variant="h4">Sign in</Typography>
					<Button variant="ghost" dimension="compact" onclick={close} disabled={isProcessing}>
						<CloseLarge size={20} />
					</Button>
				</Horizontal>
				<Vertical --vertical-gap="var(--half-padding)">
					<Typography>
						Select your synced account type below to sign in, or import a local account from a file.
					</Typography>
					{#if fileError}
						<ErrorMessage>{fileError}</ErrorMessage>
					{/if}
				</Vertical>
				<Horizontal --horizontal-justify-content="space-between" --horizontal-align-items="center">
					<Horizontal --horizontal-gap="var(--half-padding)">
						<Button variant="strong" onclick={handleEthereumClick} disabled={isProcessing}>
							<EthereumLogo width={20} height={20} />
							Ethereum
						</Button>
						<Button variant="strong" onclick={handlePasskeyClick} disabled={isProcessing}>
							<PasskeyLogo width={20} height={20} />
							Passkey
						</Button>
					</Horizontal>
					<Button variant="ghost" onclick={handleLocalAccountClick} disabled={isProcessing}>
						<Upload size={20} />
						Local account
					</Button>
				</Horizontal>
			</Vertical>
		</div>
	</Modal>
{/if}

<style>
	.hidden-file-input {
		display: none;
	}

	.dragging {
		outline: 2px dashed var(--colors-ultra-high-50);
		outline-offset: -4px;
	}

	.error-overlay {
		position: fixed;
		inset: 0;
		background: var(--colors-ultra-low);
		z-index: 100;
		display: flex;
		flex-direction: column;
		padding: var(--double-padding);
	}

	.error-content {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.mobile-overlay {
		position: fixed;
		inset: 0;
		background: var(--colors-ultra-low);
		z-index: 100;
		display: flex;
		flex-direction: column;
		padding: var(--padding);
	}

	.mobile-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.mobile-content {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--double-padding);
	}

	:global(.mobile-buttons) {
		padding-bottom: var(--padding);
	}

	@media screen and (max-width: 640px) {
		.error-overlay {
			padding: var(--padding);
		}
	}
</style>
