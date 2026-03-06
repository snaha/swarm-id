<script lang="ts">
	import { goto } from '$app/navigation'
	import { createPasskeyAccount } from '$lib/passkey'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
	import Information from 'carbon-icons-svelte/lib/Information.svelte'
	import routes from '$lib/routes'
	import { navigateToConnectOrHome } from '$lib/utils/navigation'
	import { resolve } from '$app/paths'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { keccak256 } from 'ethers'
	import { Bytes } from '@ethersphere/bee-js'
	import Confirmation from '$lib/components/confirmation.svelte'
	import { onMount } from 'svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import { deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import type { AccountSyncType } from '$lib/types'

	let accountName = $state('Passkey')
	let accountType = $state<AccountSyncType>('local')
	let showTooltip = $state(false)
	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	const accountTypeItems = [
		{ value: 'local', label: 'Local' },
		{ value: 'synced', label: 'Synced' },
	]

	onMount(() => {
		const accountNameIsTaken = accountsStore.accounts.some(
			(account) => account.name === accountName,
		)
		if (accountNameIsTaken) {
			accountName = `${accountName} ${accountsStore.accounts.filter((account) => account.type === 'passkey').length + 1}`
		}
	})

	async function handleCreatePasskey() {
		if (!accountName.trim()) {
			error = 'Please enter an account name'
			return
		}

		try {
			isProcessing = true
			error = undefined
			console.log('🔐 Creating passkey account...')

			// Create a new passkey account using account name as userId
			// Different names create different credentials on the same authenticator
			console.log('📝 Creating new passkey account for:', accountName)
			const swarmIdDomain = window.location.hostname
			const challenge = new Bytes(keccak256(new TextEncoder().encode(swarmIdDomain))).toUint8Array()

			const account = await createPasskeyAccount({
				rpName: 'Swarm ID',
				rpId: swarmIdDomain,
				challenge,
				userId: accountName.trim(),
				userName: accountName.trim(),
				userDisplayName: accountName.trim(),
			})
			console.log('✅ Passkey created successfully')

			// Derive swarmEncryptionKey from master key
			const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(account.masterKey.toHex())
			console.log('🔑 SwarmEncryptionKey derived')

			// Store account WITHOUT masterKey (passkey accounts never persist masterKey)
			const newAccount = accountsStore.addAccount({
				id: account.ethereumAddress,
				createdAt: Date.now(),
				name: accountName.trim(),
				type: 'passkey',
				credentialId: account.credentialId,
				swarmEncryptionKey: swarmEncryptionKey,
			})
			sessionStore.setAccount(newAccount)
			sessionStore.setSyncedCreation(accountType === 'synced')

			// Keep masterKey in session ONLY (not in account)
			sessionStore.setTemporaryMasterKey(account.masterKey)
			console.log('🔑 MasterKey stored in session (temporary)')

			// Navigate to identity creation page
			goto(resolve(routes.IDENTITY_NEW))
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create passkey identity'
			console.error('❌ Passkey creation failed:', err)
			isProcessing = false
		}
	}
</script>

{#if isProcessing}
	<Confirmation authenticationType="passkey" />
{:else}
	<CreationLayout
		title="Sign up with Passkey"
		description="Create a Swarm ID account on this device using a passkey"
		onClose={navigateToConnectOrHome}
	>
		{#snippet content()}
			<Vertical --vertical-gap="var(--padding)">
				<div class="form-row">
					<div class="form-field">
						<Input
							variant="outline"
							dimension="compact"
							name="account-name"
							bind:value={accountName}
							placeholder="Enter account name"
							disabled={isProcessing}
							label="Account name"
						/>
					</div>
					<div class="type-row">
						<div class="form-field">
							<Select
								variant="outline"
								dimension="compact"
								label="Account type"
								bind:value={accountType}
								items={accountTypeItems}
							/>
						</div>
						<div class="info-button">
							<Tooltip
								show={showTooltip}
								position="bottom"
								variant="small"
								color="dark"
								maxWidth="279px"
							>
								<Button
									dimension="compact"
									variant="ghost"
									onmouseenter={() => (showTooltip = true)}
									onmouseleave={() => (showTooltip = false)}
									onclick={(e: MouseEvent) => {
										e.stopPropagation()
										showTooltip = !showTooltip
									}}
								>
									<Information size={20} />
								</Button>
								{#snippet helperText()}
									Local accounts are free and faster to set up but are limited to viewing content on
									this device. Synced accounts enable uploading data and syncing across devices but
									require purchasing a Swarm postage stamp. <strong
										>Not sure yet? You can always upgrade from Local to Synced later.</strong
									>
								{/snippet}
							</Tooltip>
						</div>
					</div>
				</div>

				{#if error}
					<ErrorMessage>
						{error}
					</ErrorMessage>
				{/if}
			</Vertical>
		{/snippet}

		{#snippet buttonContent()}
			<Button
				dimension="compact"
				onclick={handleCreatePasskey}
				disabled={isProcessing}
				class="mobile-full-width"
			>
				<span class="desktop-only"><Checkmark size={20} /></span>
				{isProcessing ? 'Creating...' : 'Confirm with Passkey'}
				<span class="mobile-only"
					>{#if !isProcessing}<ArrowRight size={20} />{/if}</span
				>
			</Button>
		{/snippet}
	</CreationLayout>
{/if}

<style>
	.form-row {
		display: flex;
		gap: var(--half-padding);
		align-items: flex-end;
	}

	.form-field {
		flex: 1;
	}

	.type-row {
		display: flex;
		gap: var(--half-padding);
		align-items: flex-end;
		flex: 1;
	}

	.info-button {
		display: flex;
		align-items: flex-end;
	}

	.desktop-only {
		display: inline-flex;
	}

	.mobile-only {
		display: none;
	}

	@media screen and (max-width: 640px) {
		.form-row {
			flex-direction: column;
			align-items: stretch;
		}

		.desktop-only {
			display: none;
		}

		.mobile-only {
			display: inline-flex;
		}
	}
</style>
