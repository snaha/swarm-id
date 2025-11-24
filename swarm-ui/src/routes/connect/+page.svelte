<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import ConnectedAppHeader from '$lib/components/connected-app-header.svelte'
	import CreateNewIdentity from '$lib/components/create-new-identity.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import { deriveSecret } from '$lib/utils/key-derivation'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'

	let appOrigin = $state('')
	let appName = $state('')
	let masterKey = $state<string | undefined>(undefined)
	let postageBatchId = $state('')
	let signerKey = $state('')
	let error = $state<string | undefined>(undefined)
	let authenticated = $state(false)

	onMount(() => {
		// Validate opener window
		if (!window.opener) {
			error = 'No opener window found. This page must be opened by Swarm ID iframe.'
			return
		}

		// Check opener origin
		try {
			const openerOrigin = (window.opener as Window).location.origin
			if (openerOrigin !== window.location.origin) {
				error = `Opener origin (${openerOrigin}) does not match expected origin`
				return
			}
		} catch {
			error = 'Cannot verify opener origin - cross-origin access denied'
			return
		}

		// Get app origin from URL parameter
		const origin = $page.url.searchParams.get('origin')
		if (!origin) {
			error = 'No origin parameter found in URL'
			return
		}

		appOrigin = origin

		// Extract app name from origin (simple extraction from domain)
		try {
			const url = new URL(origin)
			appName = url.hostname.split('.')[0] || url.hostname
		} catch {
			appName = origin
		}

		// Load master key from current account
		const currentAccountId = sessionStore.data.currentAccountId
		if (currentAccountId) {
			const account = accountsStore.getAccount(currentAccountId)
			if (account) {
				masterKey = account.masterKey
			}
		}
	})

	async function handleAuthenticate() {
		if (!masterKey) {
			error = 'No master key available. Please set up an identity first.'
			return
		}

		if (!appOrigin) {
			error = 'Unknown app origin. Cannot authenticate.'
			return
		}

		if (!postageBatchId && !signerKey) {
			error = 'Please provide at least a postage batch ID or signer key'
			return
		}

		try {
			// Derive app-specific secret
			const appSecret = await deriveSecret(masterKey, appOrigin)

			// Send secret to opener (the iframe that opened this popup)
			if (!window.opener || (window.opener as Window).closed) {
				error = 'Opener window not available'
				return
			}

			;(window.opener as WindowProxy).postMessage(
				{
					type: 'setSecret',
					appOrigin: appOrigin,
					data: {
						secret: appSecret,
						postageBatchId: postageBatchId || undefined,
						signerKey: signerKey || undefined,
					},
				},
				window.location.origin,
			)

			authenticated = true

			// Close popup after a short delay
			setTimeout(() => {
				window.close()
			}, 1500)
		} catch (err) {
			error = err instanceof Error ? err.message : 'Authentication failed'
		}
	}
</script>

{#if error}
	<Vertical --vertical-gap="var(--padding)">
		<Typography variant="h3">Error</Typography>
		<Typography>{error}</Typography>
	</Vertical>
{:else if authenticated}
	<Vertical --vertical-gap="var(--padding)">
		<Typography variant="h3">Authentication Successful</Typography>
		<Typography>This window will close automatically...</Typography>
	</Vertical>
{:else}
	<ConnectedAppHeader {appName} appUrl={appOrigin} />

	{#if masterKey}
		<!-- User has a master key, show authentication form -->
		<Vertical --vertical-gap="var(--padding)">
			<Typography variant="h4">Authenticate</Typography>
			<Typography variant="small">Master Key: {masterKey.substring(0, 16)}...</Typography>

			<Vertical --vertical-gap="var(--half-padding)">
				<Typography>Postage Batch ID (optional)</Typography>
				<Input
					variant="outline"
					dimension="compact"
					name="postage-batch-id"
					bind:value={postageBatchId}
					placeholder="Enter postage batch ID"
				/>
			</Vertical>

			<Vertical --vertical-gap="var(--half-padding)">
				<Typography>Signer Key (optional)</Typography>
				<Input
					variant="outline"
					dimension="compact"
					name="signer-key"
					bind:value={signerKey}
					placeholder="Enter signer key"
				/>
			</Vertical>

			<Button dimension="compact" onclick={handleAuthenticate}>Authenticate and Connect</Button>
		</Vertical>
	{:else}
		<!-- No master key, show setup options -->
		<CreateNewIdentity />
	{/if}
{/if}
