<script lang="ts">
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import { onMount } from 'svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import SwarmLogo from '$lib/components/swarm-logo.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Confirmation from '$lib/components/confirmation.svelte'
	import routes from '$lib/routes'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { connectAndSign } from '$lib/ethereum'
	import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
	import { decryptEncryptedExport, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import { Bytes } from '@ethersphere/bee-js'

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

			const { data } = result

			// Restore account
			accountsStore.addAccount(data.account)

			// Restore identities
			for (const identity of data.identities) {
				identitiesStore.addIdentity(identity)
			}

			// Restore connected apps (appSecret omitted, will be re-derived on next connection)
			for (const app of data.connectedApps) {
				connectedAppsStore.addOrUpdateApp(app, 0)
			}

			// Restore postage stamps
			for (const stamp of data.postageStamps) {
				try {
					postageStampsStore.addStamp(stamp)
				} catch {
					// Skip duplicate stamps
				}
			}

			// Set session
			sessionStore.setAccount(data.account)
			sessionStore.setTemporaryMasterKey(masterKey)
			sessionStore.clearImportData()

			goto(resolve(routes.HOME))
		} catch {
			error =
				'Authentication failed. Make sure you used the same Ethereum wallet used during account creation.'
			isProcessing = false
		}
	}

	function handleTryAgain() {
		error = undefined
	}

	function handleClose() {
		sessionStore.clearImportData()
		goto(resolve(routes.HOME))
	}
</script>

{#if error}
	<div class="error-overlay">
		<div class="error-logo">
			<SwarmLogo fill="var(--colors-ultra-high)" height={30} />
		</div>
		<div class="error-content">
			<Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
				<Vertical --vertical-gap="var(--half-padding)">
					<Typography variant="h4" center>‼️ Sign in failed</Typography>
					<Typography center>{error}</Typography>
				</Vertical>
				<Button variant="strong" onclick={handleTryAgain}>Try again</Button>
			</Vertical>
		</div>
	</div>
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

<style>
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

	@media screen and (max-width: 640px) {
		.error-overlay {
			padding: var(--padding);
		}

		:global(.mobile-full-width) {
			width: 100%;
			justify-content: center;
		}
	}
</style>
