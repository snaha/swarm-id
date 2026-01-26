<script lang="ts">
	import CreateIdentityButton from '$lib/components/create-identity-button.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import AccountSelector from '$lib/components/account-selector.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { EthAddress } from '@ethersphere/bee-js'
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import type { Identity } from '$lib/types'
	import routes from '$lib/routes'
	import Confirmation from '$lib/components/confirmation.svelte'

	let selectedAccountId = $state<EthAddress | undefined>(undefined)
	const selectedAccount = $derived(
		selectedAccountId ? accountsStore.getAccount(selectedAccountId) : undefined,
	)
	let isAuthenticating = $state(false)

	// Get identities from store, filtered by selected account
	const allIdentities = $derived(identitiesStore.identities)
	const identities = $derived.by(() => {
		const accountId = selectedAccountId
		if (!accountId) return allIdentities
		return allIdentities.filter((identity) => identity.accountId.equals(accountId))
	})
	const hasAccounts = $derived(accountsStore.accounts.length > 0)

	// Redirect to account creation if no accounts exist
	$effect(() => {
		if (!hasAccounts) {
			goto(resolve(routes.ACCOUNT_NEW))
		}
	})

	function handleIdentityClick(identity: Identity) {
		goto(resolve(routes.IDENTITY, { id: identity.id }))
	}
</script>

{#if isAuthenticating && selectedAccount}
	<Confirmation authenticationType={selectedAccount?.type} />
{:else if hasAccounts}
	<Vertical>
		<Typography variant="h4">Welcome to Swarm ID</Typography>
		<Typography variant="small"
			>{identities.length > 0
				? 'Choose an identity to continue'
				: 'Create an identity to continue'}</Typography
		>
		<Vertical --vertical-gap="var(--double-padding)">
			<AccountSelector bind:selectedAccount={selectedAccountId} />
			<IdentityList {identities} onIdentityClick={handleIdentityClick} />
			<Horizontal --horizontal-justify-content="flex-start">
				<CreateIdentityButton account={selectedAccount} {isAuthenticating} />
			</Horizontal>
		</Vertical>
	</Vertical>
{/if}
