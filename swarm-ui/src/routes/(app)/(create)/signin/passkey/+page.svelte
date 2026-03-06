<script lang="ts">
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
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
	import { networkSettingsStore } from '$lib/stores/network-settings.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { restoreAccountFromSwarm, deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import { Bee, BatchId } from '@ethersphere/bee-js'

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

				account = accountsStore.addAccount({
					id: passkeyAccount.ethereumAddress,
					createdAt: result.snapshot.metadata.createdAt,
					name: result.snapshot.metadata.accountName ?? 'Passkey',
					type: 'passkey',
					credentialId: passkeyAccount.credentialId,
					swarmEncryptionKey,
					defaultPostageStampBatchID: result.snapshot.metadata.defaultPostageStampBatchID
						? new BatchId(result.snapshot.metadata.defaultPostageStampBatchID)
						: undefined,
				})

				// Restore identities
				for (const identity of result.snapshot.identities) {
					identitiesStore.addIdentity(identity)
				}

				// Restore connected apps
				for (const app of result.snapshot.connectedApps) {
					connectedAppsStore.addOrUpdateApp(app, 0)
				}

				// Restore postage stamps
				for (const stamp of result.snapshot.postageStamps) {
					try {
						postageStampsStore.addStamp(stamp)
					} catch {
						// Stamp may already exist, skip
					}
				}
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
	<div class="error-overlay">
		<div class="error-logo">
			<SwarmLogo fill="var(--colors-ultra-high)" height={30} />
		</div>
		<div class="error-content">
			<Vertical --vertical-gap="var(--double-padding)" --vertical-align-items="center">
				<Vertical --vertical-gap="var(--half-padding)">
					<Typography variant="h4" center>‼️ Sign in failed</Typography>
					<Typography center
						>Make sure you're using the same Passkey used during account creation.</Typography
					>
				</Vertical>
				<Button variant="strong" onclick={handleTryAgain}>Try again</Button>
			</Vertical>
		</div>
	</div>
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
