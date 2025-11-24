<script lang="ts">
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'

	let message = $state('')

	const accountCount = $derived(accountsStore.accounts.length)
	const identityCount = $derived(identitiesStore.identities.length)
	const connectionCount = $derived(connectedAppsStore.apps.length)
	const stampCount = $derived(postageStampsStore.stamps.length)

	function resetTestData() {
		// Clear existing data
		accountsStore.clear()
		identitiesStore.clear()
		connectedAppsStore.clear()
		postageStampsStore.clear()

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
		// Alice has connected to multiple apps
		connectedAppsStore.addOrUpdateApp({
			appUrl: 'https://swarm-app.local:8080',
			appName: 'Swarm App',
			identityId: identity1.id,
			favicon: 'https://www.ethswarm.org/favicon.ico',
		})

		connectedAppsStore.addOrUpdateApp({
			appUrl: 'https://example.com',
			appName: 'Example App',
			identityId: identity1.id,
			favicon: 'https://example.com/favicon.ico',
		})

		connectedAppsStore.addOrUpdateApp({
			appUrl: 'https://github.com',
			appName: 'GitHub',
			identityId: identity1.id,
			favicon: 'https://github.com/favicon.ico',
		})

		// Bob has connected to swarm-app
		connectedAppsStore.addOrUpdateApp({
			appUrl: 'https://swarm-app.local:8080',
			appName: 'Swarm App',
			identityId: identity2.id,
			favicon: 'https://www.ethswarm.org/favicon.ico',
		})

		// Charlie has connected to localhost
		connectedAppsStore.addOrUpdateApp({
			appUrl: 'http://localhost:5173',
			appName: 'localhost',
			identityId: identity3.id,
		})

		// Create postage stamps
		// Alice has 3 stamps
		const aliceStamp1 = postageStampsStore.addStamp({
			identityId: identity1.id,
			batchID: 'a41d4c7c89e5f42a3b9d8e7f1c2a4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b',
			utilization: 0.5, // 50% used
			usable: true,
			depth: 17,
			amount: '10000000',
			bucketDepth: 16,
			blockNumber: 1234567,
			immutableFlag: false,
			exists: true,
			batchTTL: 86400,
		})

		postageStampsStore.addStamp({
			identityId: identity1.id,
			batchID: 'b52e5d8d9af6g53b4c0e9f8g2d3b5c6e7f8g0a1b2c3d4e5f6b7c8d9e0f1a2c',
			utilization: 0.15, // 15% used
			usable: true,
			depth: 18,
			amount: '20000000',
			bucketDepth: 16,
			blockNumber: 1234580,
			immutableFlag: false,
			exists: true,
			batchTTL: 172800,
		})

		postageStampsStore.addStamp({
			identityId: identity1.id,
			batchID: 'c63f6e9eabg7h64c5d1f0g9h3e4c6d7f8g9h1b2c3d4e5f6g7c8d9e0f1b2d3e',
			utilization: 0.92, // 92% used - almost full!
			usable: true,
			depth: 17,
			amount: '8000000',
			bucketDepth: 16,
			blockNumber: 1200000,
			immutableFlag: false,
			exists: true,
			batchTTL: 43200,
		})

		// Bob has 1 stamp
		const bobStamp1 = postageStampsStore.addStamp({
			identityId: identity2.id,
			batchID: 'd74g7f0fbch8i75d6e2g1h0i4f5d7e8g9h0i2c3d4e5f6g7h8d9e0f1c2e3f4g',
			utilization: 0.25, // 25% used
			usable: true,
			depth: 20,
			amount: '50000000',
			bucketDepth: 16,
			blockNumber: 1235000,
			immutableFlag: false,
			exists: true,
		})

		// Set default stamps
		identitiesStore.setDefaultStamp(identity1.id, aliceStamp1.batchID)
		identitiesStore.setDefaultStamp(identity2.id, bobStamp1.batchID)

		message = `✅ Test data created:
- 2 accounts (1 passkey, 1 ethereum)
- 5 identities (Alice, Bob, Charlie, Diana, Eve)
- 5 app connections:
  * Alice → Swarm App, Example App, GitHub
  * Bob → Swarm App
  * Charlie → localhost
- 4 postage stamps:
  * Alice → 3 stamps (1 default: a41d4c7c)
  * Bob → 1 stamp (default: d74g7f0f)
- Diana and Eve have no connections or stamps yet

To test the grouped list, open:
/connect?origin=https://swarm-app.local:8080
or
/connect?origin=http://localhost:5173`
	}

	function clearAllData() {
		accountsStore.clear()
		identitiesStore.clear()
		connectedAppsStore.clear()
		postageStampsStore.clear()
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
		connections, {stampCount} stamps.</Typography
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
