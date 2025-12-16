<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Add from 'carbon-icons-svelte/lib/Add.svelte'
	import { goto } from '$app/navigation'
	import { sessionStore } from '$lib/stores/session.svelte'
	import routes from '$lib/routes'
	import { getMasterKeyFromAccount } from '$lib/utils/account-auth'
	import type { Account } from '$lib/types'

	interface Props {
		account?: Account
		/** Optional origin to include in redirect URL (for connect flow) */
		redirectOrigin?: string
		/** Whether to show the Add icon. Default: true */
		showIcon?: boolean
	}

	let { account, redirectOrigin, showIcon = true }: Props = $props()

	async function handleClick() {
		if (!account) return

		try {
			const masterKey = await getMasterKeyFromAccount(account)
			sessionStore.setAccount(account)
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

<Button variant="ghost" dimension="compact" leftAlign onclick={handleClick}>
	{#if showIcon}<Add size={20} />{/if}Create new identity
</Button>
