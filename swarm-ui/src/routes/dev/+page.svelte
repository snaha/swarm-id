<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'

	let message = $state('')

	const accountCount = $derived(accountsStore.accounts.length)
	const identityCount = $derived(identitiesStore.identities.length)
	const connectionCount = $derived(connectedAppsStore.apps.length)

	function resetTestData() {
		// Clear existing data
		accountsStore.clear()
		identitiesStore.clear()
		connectedAppsStore.clear()

		// Create test accounts
		const account1 = accountsStore.addAccount({
			name: 'Test Account 1',
			type: 'passkey',
			masterKey: 'test-master-key-1',
		})

		const account2 = accountsStore.addAccount({
			name: 'Test Account 2',
			type: 'ethereum',
			masterKey: 'test-master-key-2',
			ethereumAddress: '0x1234567890123456789012345678901234567890',
		})

		// Create identities
		const identity1 = identitiesStore.addIdentity({
			accountId: account1.id,
			name: 'Alice',
		})

		const identity2 = identitiesStore.addIdentity({
			accountId: account1.id,
			name: 'Bob',
		})

		const identity3 = identitiesStore.addIdentity({
			accountId: account2.id,
			name: 'Charlie',
		})

		// Diana and Eve don't have any connections yet
		identitiesStore.addIdentity({
			accountId: account2.id,
			name: 'Diana',
		})

		identitiesStore.addIdentity({
			accountId: account1.id,
			name: 'Eve',
		})

		// Create connected app records for some identities
		// Alice and Bob have connected to swarm-app.local:8080 before
		connectedAppsStore.addOrUpdateApp({
			appUrl: 'https://swarm-app.local:8080',
			appName: 'swarm-app',
			identityId: identity1.id,
		})

		connectedAppsStore.addOrUpdateApp({
			appUrl: 'https://swarm-app.local:8080',
			appName: 'swarm-app',
			identityId: identity2.id,
		})

		// Charlie has connected to localhost:5173 before
		connectedAppsStore.addOrUpdateApp({
			appUrl: 'http://localhost:5173',
			appName: 'localhost',
			identityId: identity3.id,
		})

		message = `✅ Test data created:
- 2 accounts (1 passkey, 1 ethereum)
- 5 identities (Alice, Bob, Charlie, Diana, Eve)
- 3 app connections:
  * Alice → https://swarm-app.local:8080
  * Bob → https://swarm-app.local:8080
  * Charlie → http://localhost:5173
- Diana and Eve have no connections yet

To test the grouped list, open:
/connect?origin=https://swarm-app.local:8080
or
/connect?origin=http://localhost:5173`
	}

	function clearAllData() {
		accountsStore.clear()
		identitiesStore.clear()
		connectedAppsStore.clear()
		message = '🗑️ All test data cleared'
	}
</script>

<Vertical
	--vertical-gap="var(--double-padding)"
	style="max-width: 800px; margin: 0 auto; padding: var(--double-padding);"
>
	<Typography variant="h2">Dev Setup - Test Data</Typography>
	<Typography
		>Current data: {accountCount} accounts, {identityCount} identities, {connectionCount}
		connections.</Typography
	>

	<Horizontal --horizontal-gap="var(--padding)">
		<Button onclick={resetTestData}>Create/Reset Test Data</Button>
		<Button variant="ghost" onclick={clearAllData}>Clear All Data</Button>
	</Horizontal>

	{#if message}
		<Vertical
			--vertical-gap="var(--padding)"
			style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low); white-space: pre-wrap;"
		>
			<Typography font="mono">{message}</Typography>
		</Vertical>
	{/if}

	<Vertical --vertical-gap="var(--padding)">
		<Typography variant="h3">Test URLs</Typography>
		<Vertical --vertical-gap="var(--half-padding)">
			<a href="/connect?origin=https://swarm-app.local:8080">
				<Button variant="ghost" dimension="compact">Test: swarm-app.local:8080</Button>
			</a>
			<a href="/connect?origin=http://localhost:5173">
				<Button variant="ghost" dimension="compact">Test: localhost:5173</Button>
			</a>
		</Vertical>
	</Vertical>
</Vertical>
