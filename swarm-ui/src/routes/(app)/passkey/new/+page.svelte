<script lang="ts">
	import { goto } from '$app/navigation'
	import { createPasskeyAccount } from '$lib/passkey'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { keccak256 } from 'ethers'
	import { Bytes } from '@ethersphere/bee-js'
	import Confirmation from '$lib/components/confirmation.svelte'
	import { onMount } from 'svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'

	let accountName = $state('Passkey')
	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

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

			// Store account WITHOUT masterKey (passkey accounts never persist masterKey)
			const newAccount = accountsStore.addAccount({
				id: account.ethereumAddress,
				createdAt: Date.now(),
				name: accountName.trim(),
				type: 'passkey',
				credentialId: account.credentialId,
			})
			sessionStore.setAccount(newAccount)

			// Keep masterKey in session ONLY (not in account)
			sessionStore.setTemporaryMasterKey(account.masterKey)
			console.log('🔑 MasterKey stored in session (temporary)')

			// Navigate to identity creation page
			goto(routes.IDENTITY_NEW)
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
		title="Create account with Passkey"
		description="Create a new Swarm ID account using Passkey"
		onClose={() => (sessionStore.data.appOrigin ? goto(routes.CONNECT) : goto(routes.HOME))}
	>
		{#snippet content()}
			<Vertical --vertical-gap="var(--padding)">
				<Input
					variant="outline"
					dimension="compact"
					name="account-name"
					bind:value={accountName}
					placeholder="Enter account name"
					disabled={isProcessing}
					label="Account name"
				/>

				{#if error}
					<ErrorMessage>
						{error}
					</ErrorMessage>
				{/if}
			</Vertical>
		{/snippet}

		{#snippet buttonContent()}
			<Button dimension="compact" onclick={handleCreatePasskey} disabled={isProcessing}>
				{isProcessing ? 'Creating...' : 'Confirm with Passkey'}
				{#if !isProcessing}<ArrowRight />{/if}
			</Button>
		{/snippet}
	</CreationLayout>
{/if}
