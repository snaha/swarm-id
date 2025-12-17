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
		/** Whether to show the Add icon. Default: true */
		showIcon?: boolean
		isAuthenticating?: boolean
	}

	let { account, showIcon = true, isAuthenticating = $bindable(false) }: Props = $props()

	async function handleClick() {
		if (!account) return

		try {
			isAuthenticating = true
			const masterKey = await getMasterKeyFromAccount(account)
			sessionStore.setAccount(account)
			sessionStore.setTemporaryMasterKey(masterKey)
			goto(routes.IDENTITY_NEW)
		} catch (err) {
			console.error('Failed to authenticate:', err)
			isAuthenticating = false
		}
	}
</script>

<Button variant="ghost" dimension="compact" leftAlign onclick={handleClick}>
	{#if showIcon}<Add size={20} />{/if}Create new identity
</Button>
