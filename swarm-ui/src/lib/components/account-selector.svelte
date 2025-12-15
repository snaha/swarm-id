<script lang="ts">
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Add from 'carbon-icons-svelte/lib/Add.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'

	interface Props {
		selectedAccountId: string | undefined
		onCreateAccount?: () => void
	}

	let { selectedAccountId = $bindable(), onCreateAccount }: Props = $props()

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
</script>

<Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
	<Typography>Account</Typography>
	<Select
		items={accountItems}
		bind:value={selectedAccountId}
		dimension="compact"
		variant="solid"
		actionLabel="Add account..."
		actionIcon={Add}
		onaction={onCreateAccount}
	/>
</Horizontal>
