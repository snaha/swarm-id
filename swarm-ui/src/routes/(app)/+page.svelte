<script lang="ts">
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import Add from 'carbon-icons-svelte/lib/Add.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { goto } from '$app/navigation'
	import type { Identity, Account } from '$lib/types'
	import routes from '$lib/routes'
	import { authenticateWithPasskey } from '$lib/passkey'
	import { connectAndSign } from '$lib/ethereum'
	import { decryptMasterKey, deriveEncryptionKey } from '$lib/utils/encryption'
	import { keccak256 } from 'ethers'
	import { hexToUint8Array } from '$lib/utils/key-derivation'

	let selectedAccountId = $state<string | undefined>(undefined)

	const accounts = $derived(accountsStore.accounts)
	const accountItems = $derived(
		accounts.map((account) => ({
			value: account.id,
			label: account.name,
			icon: account.type === 'passkey' ? PasskeyLogo : EthereumLogo,
		})),
	)

	// Initialize from session store or default to first account
	$effect(() => {
		if (!selectedAccountId) {
			if (sessionStore.data.account?.id) {
				selectedAccountId = sessionStore.data.account.id
			} else if (accounts.length > 0) {
				selectedAccountId = accounts[0].id
				sessionStore.setAccount(accounts[0])
			}
		}
	})

	// Sync selection changes to session store
	$effect(() => {
		if (selectedAccountId && selectedAccountId !== sessionStore.data.account?.id) {
			const account = accountsStore.getAccount(selectedAccountId)
			if (account) {
				sessionStore.setAccount(account)
			}
		}
	})

	// Get identities from store, filtered by selected account
	const allIdentities = $derived(identitiesStore.identities)
	const identities = $derived(
		selectedAccountId
			? allIdentities.filter((identity) => identity.accountId === selectedAccountId)
			: allIdentities,
	)
	const hasIdentities = $derived(identities.length > 0)

	let showCreateMode = $state(false)

	function handleCreateNew() {
		showCreateMode = true
	}

	function handleIdentityClick(identity: Identity) {
		goto(routes.IDENTITY(identity.id))
	}

	async function getMasterKeyFromAccount(account: Account): Promise<string> {
		if (account.type === 'passkey') {
			const swarmIdDomain = window.location.hostname
			const challenge = hexToUint8Array(keccak256(new TextEncoder().encode(swarmIdDomain)))
			// Use allowCredentials to guide WebAuthn to the correct passkey
			const passkeyAccount = await authenticateWithPasskey({
				rpId: swarmIdDomain,
				challenge,
				allowCredentials: [{ id: account.credentialId, type: 'public-key' }],
			})
			return passkeyAccount.masterKey
		} else {
			const signed = await connectAndSign()
			const encryptionKey = await deriveEncryptionKey(signed.publicKey, account.encryptionSalt)
			return await decryptMasterKey(account.encryptedMasterKey, encryptionKey)
		}
	}

	async function handleCreateNewIdentity() {
		if (!selectedAccountId) return
		const account = accountsStore.getAccount(selectedAccountId)
		if (!account) return

		try {
			const masterKey = await getMasterKeyFromAccount(account)
			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(masterKey)
			goto(routes.IDENTITY_NEW)
		} catch (err) {
			console.error('Failed to authenticate:', err)
		}
	}
</script>

<Vertical>
	<Typography variant="h4">Welcome to Swarm ID</Typography>

	{#if hasIdentities && !showCreateMode}
		<Typography variant="small">Choose an identity to continue</Typography>
		<Vertical --vertical-gap="var(--double-padding)">
			<Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
				<Typography>Account</Typography>
				<Select
					items={accountItems}
					bind:value={selectedAccountId}
					dimension="compact"
					variant="solid"
					actionLabel="Add account..."
					actionIcon={Add}
					onaction={handleCreateNew}
				/>
			</Horizontal>
			<IdentityList {identities} onIdentityClick={handleIdentityClick} />
			<Horizontal --horizontal-justify-content="flex-start">
				<Button variant="ghost" dimension="compact" onclick={handleCreateNewIdentity}>
					<Add size={20} />Create new identity
				</Button>
			</Horizontal>
		</Vertical>
	{:else}
		<Typography variant="small">Create or import an account to continue</Typography>
		<CreateNewIdentity />
	{/if}
</Vertical>
