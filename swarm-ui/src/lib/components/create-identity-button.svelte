<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Add from 'carbon-icons-svelte/lib/Add.svelte'
	import { goto } from '$app/navigation'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import routes from '$lib/routes'
	import { getMasterKeyFromAccount } from '$lib/utils/account-auth'
	import { notImplemented } from '$lib/utils/not-implemented'
	import type { Account } from '$lib/types'

	interface Props {
		/** Account to create identity for. Either this or accountId must be provided. */
		account?: Account
		/** Account ID to look up. Either this or account must be provided. */
		accountId?: string
		/** Optional origin to include in redirect URL (for connect flow) */
		redirectOrigin?: string
		/** Whether to show the Add icon. Default: true */
		showIcon?: boolean
	}

	let { account, accountId, redirectOrigin, showIcon = true }: Props = $props()

	const resolvedAccount = $derived(
		account ?? (accountId ? accountsStore.getAccount(accountId) : undefined),
	)

	async function handleClick() {
		if (!resolvedAccount) return
		if (resolvedAccount.type === 'ethereum') {
			notImplemented()
			return
		}

		try {
			const masterKey = await getMasterKeyFromAccount(resolvedAccount)
			sessionStore.setAccount(resolvedAccount)
			sessionStore.setTemporaryMasterKey(masterKey)
			const url = redirectOrigin
				? `${routes.IDENTITY_NEW}?origin=${encodeURIComponent(redirectOrigin)}`
				: routes.IDENTITY_NEW
			goto(url)
		} catch (err) {
			console.error('Failed to authenticate:', err)
		}
	}
</script>

<Button variant="ghost" dimension="compact" onclick={handleClick}>
	{#if showIcon}<Add size={20} />{/if}Create new identity
</Button>
