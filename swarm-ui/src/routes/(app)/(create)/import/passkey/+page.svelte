<script lang="ts">
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import { onMount } from 'svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Confirmation from '$lib/components/confirmation.svelte'
	import routes from '$lib/routes'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { decryptEncryptedExport, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'

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

			const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(
				passkeyAccount.masterKey.toHex(),
			)

			const result = await decryptEncryptedExport(fileData, swarmEncryptionKey)

			if (!result.success) {
				error = 'Decryption failed. Make sure you used the correct Passkey.'
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
			sessionStore.setTemporaryMasterKey(passkeyAccount.masterKey)
			sessionStore.clearImportData()

			goto(resolve(routes.HOME))
		} catch {
			error =
				'Authentication failed. Make sure you used the same Passkey used during account creation.'
			isProcessing = false
		}
	}

	function handleClose() {
		sessionStore.clearImportData()
		goto(resolve(routes.HOME))
	}
</script>

{#if isProcessing}
	<Confirmation authenticationType="passkey" />
{:else}
	<CreationLayout title="Sign in with Passkey" onClose={handleClose}>
		{#snippet content()}
			<Typography>
				Make sure to use the same Passkey you used to create your Swarm ID account.
			</Typography>
			{#if error}
				<ErrorMessage>{error}</ErrorMessage>
			{/if}
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
