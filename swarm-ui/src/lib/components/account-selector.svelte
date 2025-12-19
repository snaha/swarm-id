<script lang="ts">
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import Option from '$lib/components/ui/select/option.svelte'
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Add from 'carbon-icons-svelte/lib/Add.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { EthAddress } from '@ethersphere/bee-js'
	import { toPrefixedHex } from '$lib/utils/hex'

	interface Props {
		selectedAccount: EthAddress | undefined
		onCreateAccount?: () => void
	}

	let { selectedAccount = $bindable(), onCreateAccount }: Props = $props()

	const accounts = $derived(accountsStore.accounts)

	const selectedAccountHex = $derived(selectedAccount ? toPrefixedHex(selectedAccount) : undefined)

	const accountItems = $derived(
		accounts.map((account) => ({
			value: toPrefixedHex(account.id),
			label: account.name,
			icon: account.type === 'passkey' ? PasskeyLogo : EthereumLogo,
		})),
	)

	function handleAccountChange(hex: string) {
		const account = accountsStore.getAccount(new EthAddress(hex))
		if (account) {
			selectedAccount = account.id
			sessionStore.setAccount(account)
		}
	}

	// Initialize selected account from session or first available
	$effect(() => {
		if (!selectedAccount) {
			if (sessionStore.data.account?.id) {
				selectedAccount = sessionStore.data.account.id
			} else if (accounts.length > 0) {
				selectedAccount = accounts[0].id
				sessionStore.setAccount(accounts[0])
			}
		}
	})
</script>

<Horizontal --horizontal-gap="var(--padding)" --horizontal-align-items="center">
	<Typography>Account</Typography>
	<Select
		items={accountItems}
		value={selectedAccountHex}
		onchange={(e) => handleAccountChange(e.currentTarget.value)}
		dimension="compact"
		variant="solid"
	>
		{#snippet dropdownFooter({ close, store })}
			{#if onCreateAccount}
				<Option
					value=""
					{store}
					onclick={(e: MouseEvent) => {
						e.preventDefault()
						e.stopPropagation()
						close()
						onCreateAccount()
					}}
				>
					<span class="option-content">
						<Add size={16} />
						Add account...
					</span>
				</Option>
			{/if}
		{/snippet}
	</Select>
</Horizontal>

<style>
	.option-content {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
</style>
