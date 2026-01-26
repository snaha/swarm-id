<script lang="ts">
	import { resolve } from '$app/paths'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { identitiesStore } from '$lib/stores/identities.svelte'
	import { connectedAppsStore } from '$lib/stores/connected-apps.svelte'
	import { DEFAULT_SESSION_DURATION } from '@swarm-id/lib'
	import { postageStampsStore } from '$lib/stores/postage-stamps.svelte'
	import { syncStore } from '$lib/stores/sync.svelte'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { createEthereumWalletFromSeed } from '$lib/passkey'
	import { HDNodeWallet } from 'ethers'
	import {
		deriveEncryptionKey,
		encryptMasterKey,
		generateEncryptionSalt,
	} from '$lib/utils/encryption'
	import { BatchId, PrivateKey } from '@ethersphere/bee-js'
	import { toPrefixedHex } from '$lib/utils/hex'
	import { deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import { encryptSecretSeed, deriveSecretSeedEncryptionKey } from '$lib/utils/encryption'

	let message = $state('')
	let syncMessage = $state('')

	const accountCount = $derived(accountsStore.accounts.length)
	const identityCount = $derived(identitiesStore.identities.length)
	const connectionCount = $derived(connectedAppsStore.apps.length)
	const stampCount = $derived(postageStampsStore.stamps.length)

	async function resetTestData() {
		// Clear existing data
		accountsStore.clear()
		identitiesStore.clear()
		connectedAppsStore.clear()
		postageStampsStore.clear()

		// Generate proper hex master keys for testing
		const ethereumWallet1 = createEthereumWalletFromSeed(crypto.getRandomValues(new Uint8Array(32)))
		const ethereumWallet2 = createEthereumWalletFromSeed(crypto.getRandomValues(new Uint8Array(32)))

		// Derive swarmEncryptionKeys for both accounts
		const swarmEncryptionKey1 = await deriveAccountSwarmEncryptionKey(
			ethereumWallet1.masterKey.toHex(),
		)
		const swarmEncryptionKey2 = await deriveAccountSwarmEncryptionKey(
			ethereumWallet2.masterKey.toHex(),
		)

		// Create test accounts
		const account1 = accountsStore.addAccount({
			name: 'Test Account 1',
			type: 'passkey',
			id: ethereumWallet1.address,
			createdAt: Date.now(),
			credentialId: 'test-credential-1',
			swarmEncryptionKey: swarmEncryptionKey1,
		})

		const wallet2 = HDNodeWallet.fromSeed(toPrefixedHex(ethereumWallet2.masterKey))
		const publicKey2 = wallet2.publicKey
		const encryptionSalt2 = generateEncryptionSalt()
		const encryptionKey2 = await deriveEncryptionKey(publicKey2, encryptionSalt2)
		const encryptedMasterKey2 = await encryptMasterKey(ethereumWallet2.masterKey, encryptionKey2)
		const encryptedSecretSeed2 = await encryptSecretSeed(
			'secret-seed',
			await deriveSecretSeedEncryptionKey(ethereumWallet2.masterKey),
		)

		const account2 = accountsStore.addAccount({
			name: 'Test Account 2',
			type: 'ethereum',
			id: ethereumWallet2.address,
			createdAt: Date.now(),
			ethereumAddress: ethereumWallet2.address,
			encryptedMasterKey: encryptedMasterKey2,
			encryptionSalt: encryptionSalt2,
			swarmEncryptionKey: swarmEncryptionKey2,
			encryptedSecretSeed: encryptedSecretSeed2,
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
		connectedAppsStore.addOrUpdateApp(
			{
				appUrl: 'https://swarm-app.local:8080',
				appName: 'Swarm App',
				identityId: identity1.id,
			},
			DEFAULT_SESSION_DURATION,
		)

		connectedAppsStore.addOrUpdateApp(
			{
				appUrl: 'https://example.com',
				appName: 'Example App',
				identityId: identity1.id,
			},
			DEFAULT_SESSION_DURATION,
		)

		connectedAppsStore.addOrUpdateApp(
			{
				appUrl: 'https://github.com',
				appName: 'GitHub',
				identityId: identity1.id,
			},
			DEFAULT_SESSION_DURATION,
		)

		// Bob has connected to swarm-app
		connectedAppsStore.addOrUpdateApp(
			{
				appUrl: 'https://swarm-app.local:8080',
				appName: 'Swarm App',
				identityId: identity2.id,
			},
			DEFAULT_SESSION_DURATION,
		)

		// Charlie has connected to localhost
		connectedAppsStore.addOrUpdateApp(
			{
				appUrl: 'http://localhost:5173',
				appName: 'localhost',
				identityId: identity3.id,
			},
			DEFAULT_SESSION_DURATION,
		)

		// Create postage stamps (per-account, not per-identity)
		// Account 1 has 3 stamps
		const account1Stamp1 = postageStampsStore.addStamp({
			accountId: account1.id.toHex(),
			batchID: new BatchId('a41d4c7c89e5f42a3b9d8e7f1c2a4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b'),
			signerKey: new PrivateKey('a41d4c7c89e5f42a3b9d8e7f1c2a4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b'), // same as BatchId for testing purposes
			utilization: 0.5, // 50% used
			usable: true,
			depth: 17,
			amount: 10000000,
			bucketDepth: 16,
			blockNumber: 1234567,
			immutableFlag: false,
			exists: true,
			batchTTL: 86400,
		})

		postageStampsStore.addStamp({
			accountId: account1.id.toHex(),
			batchID: new BatchId('b52e5d8d9af6053b4c0e9f802d3b5c6e7f8000a1b2c3d4e5f6b7c8d9e0f1a2c0'),
			signerKey: new PrivateKey('b52e5d8d9af6053b4c0e9f802d3b5c6e7f8000a1b2c3d4e5f6b7c8d9e0f1a2c0'), // same as BatchId for testing purposes
			utilization: 0.15, // 15% used
			usable: true,
			depth: 18,
			amount: 20000000,
			bucketDepth: 16,
			blockNumber: 1234580,
			immutableFlag: false,
			exists: true,
			batchTTL: 172800,
		})

		postageStampsStore.addStamp({
			accountId: account1.id.toHex(),
			batchID: new BatchId('c63f6e9eab07064c5d1f009003e4c6d7f8090102c3d4e5f607c8d9e0f1b2d3e0'),
			signerKey: new PrivateKey('c63f6e9eab07064c5d1f009003e4c6d7f8090102c3d4e5f607c8d9e0f1b2d3e0'), // same as BatchId for testing purposes
			utilization: 0.92, // 92% used - almost full!
			usable: true,
			depth: 17,
			amount: 8000000,
			bucketDepth: 16,
			blockNumber: 1200000,
			immutableFlag: false,
			exists: true,
			batchTTL: 43200,
		})

		// Account 2 has 1 stamp
		const account2Stamp1 = postageStampsStore.addStamp({
			accountId: account2.id.toHex(),
			batchID: new BatchId('d74070f0bc08075d6e201004f5d7e809002c3d4e5f607089e0f1c2e3f4000000'),
			signerKey: new PrivateKey('d74070f0bc08075d6e201004f5d7e809002c3d4e5f607089e0f1c2e3f4000000'), // same as BatchId for testing purposes
			utilization: 0.25, // 25% used
			usable: true,
			depth: 20,
			amount: 50000000,
			bucketDepth: 16,
			blockNumber: 1235000,
			immutableFlag: false,
			exists: true,
		})

		// Set default stamps at account and identity levels
		accountsStore.setDefaultStamp(account1.id, account1Stamp1.batchID)
		accountsStore.setDefaultStamp(account2.id, account2Stamp1.batchID)
		// Alice and Bob can optionally override with identity-level defaults
		identitiesStore.setDefaultStamp(identity1.id, account1Stamp1.batchID)
		identitiesStore.setDefaultStamp(identity2.id, account1Stamp1.batchID)

		// Set current identity and master key in session for testing
		sessionStore.setCurrentAccount(account1.id.toString())
		sessionStore.setCurrentIdentity(identity1.id)
		sessionStore.setTemporaryMasterKey(ethereumWallet1.masterKey)

		message = `✅ Test data created:
- 2 accounts (1 passkey, 1 ethereum)
- 5 identities (Alice, Bob, Charlie, Diana, Eve)
- 5 app connections:
  * Alice → Swarm App, Example App, GitHub
  * Bob → Swarm App
  * Charlie → localhost
- 4 postage stamps (per-account):
  * Account 1 → 3 stamps (default: a41d4c7c)
  * Account 2 → 1 stamp (default: d74070f0)
- Diana and Eve have no connections yet
- Stamps are now stored per-account and shared by all identities

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

	async function triggerManualSync() {
		// Get all accounts with default stamps (account-level or via identities)
		const accountsToSync = accountsStore.accounts.filter(
			(account) =>
				account.defaultPostageStampBatchID ||
				identitiesStore
					.getIdentitiesByAccount(account.id)
					.some((id) => id.defaultPostageStampBatchID),
		)

		if (accountsToSync.length === 0) {
			syncMessage = '❌ No accounts with default postage stamps found.'
			return
		}

		syncMessage = `⏳ Syncing ${accountsToSync.length} accounts...`

		const results: string[] = []
		let successCount = 0
		let errorCount = 0

		for (const account of accountsToSync) {
			try {
				await syncStore.syncAccount(account.id.toHex())

				// Get default stamp to show utilization
				const defaultStamp =
					account.defaultPostageStampBatchID ??
					identitiesStore.getIdentitiesByAccount(account.id)[0]?.defaultPostageStampBatchID

				const stamp = defaultStamp ? postageStampsStore.getStamp(defaultStamp) : undefined
				const utilization = stamp ? stamp.utilization.toFixed(2) : 'unknown'

				const identityCount = identitiesStore.getIdentitiesByAccount(account.id).length
				results.push(
					`✅ ${account.name} (${identityCount} identities): ${utilization}% utilization`,
				)
				successCount++
			} catch (error) {
				results.push(
					`❌ ${account.name}: ${error instanceof Error ? error.message : String(error)}`,
				)
				errorCount++
			}
		}

		syncMessage = `Sync completed: ${successCount} succeeded, ${errorCount} failed

${results.join('\n')}

Check console logs for details:
- [StateSync] Tracking X chunks
- [StateSync] New utilization: Y%
- [PostageStamps] Updated utilization`
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
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- template literal with resolve() -->
			<a href={`${resolve('/(app)/connect')}?origin=https://swarm-app.local:8080`}>
				<Button variant="ghost" dimension="compact">Test: swarm-app.local:8080</Button>
			</a>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- template literal with resolve() -->
			<a href={`${resolve('/(app)/connect')}?origin=http://localhost:5173`}>
				<Button variant="ghost" dimension="compact">Test: localhost:5173</Button>
			</a>
		</Vertical>
	</Vertical>

	<Vertical --vertical-gap="var(--padding)">
		<Typography variant="h3">Manual Sync Testing</Typography>
		<Typography variant="small"
			>Trigger a manual sync for ALL accounts to test postage stamp utilization tracking.</Typography
		>
		<Horizontal --horizontal-gap="var(--padding)">
			<Button onclick={triggerManualSync}>Sync All Accounts</Button>
		</Horizontal>

		{#if syncMessage}
			<Vertical
				--vertical-gap="var(--padding)"
				style="background: var(--colors-card-bg); padding: var(--padding); border: 1px solid var(--colors-low); white-space: pre-wrap;"
			>
				<Typography font="mono">{syncMessage}</Typography>
			</Vertical>
		{/if}

		<Vertical --vertical-gap="var(--half-padding)">
			<Typography variant="small" style="color: var(--colors-medium);"
				>Requirements for sync:</Typography
			>
			<Typography variant="small" style="color: var(--colors-medium);" font="mono"
				>• Master key in session (create test data above)</Typography
			>
			<Typography variant="small" style="color: var(--colors-medium);" font="mono"
				>• At least one account with a default postage stamp</Typography
			>
			<Typography variant="small" style="color: var(--colors-medium);" font="mono"
				>• Open browser console to see detailed logs</Typography
			>
		</Vertical>
	</Vertical>
</Vertical>
