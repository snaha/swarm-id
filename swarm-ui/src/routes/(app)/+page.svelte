<script lang="ts">
	import CreateNewAccount from '$lib/components/create-new-account.svelte'
	import CreateIdentityButton from '$lib/components/create-identity-button.svelte'
	import IdentityList from '$lib/components/identity-list.svelte'
	import AccountSelector from '$lib/components/account-selector.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { goto } from '$app/navigation'
	import type { Identity } from '$lib/types'
	import routes from '$lib/routes'
	import Confirmation from '$lib/components/confirmation.svelte'

	let selectedAccountId = $state<string | undefined>(undefined)
	const selectedAccount = $derived(
		selectedAccountId ? accountsStore.getAccount(selectedAccountId) : undefined,
	)
	let isAuthenticating = $state(false)

	// Get identities from store, filtered by selected account
	const allIdentities = $derived(identitiesStore.identities)
	const identities = $derived.by(() => {
		const accountIdFilter = selectedAccountId
		if (!accountIdFilter) return allIdentities
		return allIdentities.filter((identity) => identity.accountId.equals(accountIdFilter))
	})
	const hasAccounts = $derived(accountsStore.accounts.length > 0)

	let showCreateMode = $state(false)

	function handleCreateNew() {
		showCreateMode = true
	}

	function handleIdentityClick(identity: Identity) {
		goto(routes.IDENTITY(identity.id))
	}
</script>

{#if isAuthenticating && selectedAccount}
	<Confirmation authenticationType={selectedAccount?.type} />
{:else}
	<Vertical>
		<Typography variant="h4">Welcome to Swarm ID</Typography>

		{#if hasAccounts && !showCreateMode}
			<Typography variant="small"
				>{identities.length > 0
					? 'Choose an identity to continue'
					: 'Create an identity to continue'}</Typography
			>
			<Vertical --vertical-gap="var(--double-padding)">
				<AccountSelector bind:selectedAccountId onCreateAccount={handleCreateNew} />
				<IdentityList {identities} onIdentityClick={handleIdentityClick} />
				<Horizontal --horizontal-justify-content="flex-start">
					<CreateIdentityButton account={selectedAccount} {isAuthenticating} />
				</Horizontal>
			</Vertical>
		{:else}
			<Typography variant="small">Create or import an account to continue</Typography>
			<CreateNewAccount />
		{/if}
	</Vertical>
{/if}
