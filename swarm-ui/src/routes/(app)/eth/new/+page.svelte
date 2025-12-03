<script lang="ts">
	import { onMount } from 'svelte'
	import { page } from '$app/stores'
	import { goto } from '$app/navigation'
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import FolderShared from 'carbon-icons-svelte/lib/FolderShared.svelte'
	import WorkflowAutomation from 'carbon-icons-svelte/lib/WorkflowAutomation.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import GenerateSeedModal from '$lib/components/generate-seed-modal.svelte'
	import ConfirmSaveModal from '$lib/components/confirm-save-modal.svelte'
	import { connectAndSign } from '$lib/ethereum'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { SigningKey, hashMessage } from 'ethers'
	import {
		generateEncryptionSalt,
		deriveEncryptionKey,
		encryptMasterKey,
	} from '$lib/utils/encryption'
	import { uint8ArrayToHex } from '$lib/utils/key-derivation'
	import { validateSecretSeed } from '$lib/utils/secret-seed'

	let showTooltip = $state(false)
	let showSeedModal = $state(false)
	let showConfirmModal = $state(false)
	let accountName = $state('Ethereum')
	let secretSeed = $state('')
	let appOrigin = $state<string | undefined>(undefined)
	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	onMount(() => {
		// Check if we have an origin parameter (coming from /connect)
		const origin = $page.url.searchParams.get('origin')
		if (origin) {
			appOrigin = origin
		}
	})

	let secretSeedError = $derived.by(() => {
		if (!secretSeed) return undefined

		if (!validateSecretSeed(secretSeed)) {
			return 'Use 20 to 128 characters with a mix of uppercase letters, lowercase letters, numbers, and special characters.'
		}

		return undefined
	})

	let isFormDisabled = $derived(!accountName || !secretSeed || !!secretSeedError)

	async function handleConfirm() {
		if (!accountName.trim() || !secretSeed.trim()) {
			error = 'Please fill in all fields'
			return
		}

		try {
			isProcessing = true
			error = undefined
			console.log('🔐 Connecting to Ethereum wallet...')

			// Connect wallet and sign SIWE message
			const signed = await connectAndSign({ secretSeed: secretSeed.trim() })

			console.log('✅ Wallet connected and message signed')
			console.log('📍 Wallet address:', signed.address)
			console.log('📍 Account address:', signed.masterAddress)

			// Encrypt masterKey before storage
			console.log('🔒 Encrypting masterKey...')

			// Step 1: Recover public key from signature
			const digest = hashMessage(signed.message)
			const publicKey = SigningKey.recoverPublicKey(digest, signed.signature)
			console.log('🔑 Public key recovered:', publicKey.substring(0, 16) + '...')

			// Step 2: Generate encryption salt
			const encryptionSalt = generateEncryptionSalt()
			console.log('🎲 Encryption salt generated')

			// Step 3: Derive encryption key from public key + salt
			const encryptionKey = await deriveEncryptionKey(publicKey, encryptionSalt)
			console.log('🔑 Encryption key derived')

			// Step 4: Encrypt masterKey
			const encryptedMasterKey = await encryptMasterKey(signed.masterKey, encryptionKey)
			console.log('✅ MasterKey encrypted')

			// Store account with encrypted masterKey
			sessionStore.setAccount({
				id: signed.masterAddress,
				createdAt: Date.now(),
				name: accountName.trim(),
				type: 'ethereum',
				ethereumAddress: signed.address,
				encryptedMasterKey: encryptedMasterKey,
				encryptionSalt: uint8ArrayToHex(encryptionSalt),
			})

			// Keep unencrypted masterKey in session temporarily for identity creation
			sessionStore.setTemporaryMasterKey(signed.masterKey)
			console.log('🔑 MasterKey stored in session (temporary)')

			// Navigate to identity creation page
			if (appOrigin) {
				goto(`${routes.IDENTITY_NEW}?origin=${encodeURIComponent(appOrigin)}`)
			} else {
				goto(routes.IDENTITY_NEW)
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect wallet'
			console.error('❌ Wallet connection failed:', err)
			isProcessing = false
		}
	}
</script>

<CreationLayout
	title="Create account with Ethereum"
	description="Create a new Swarm ID account using your Ethereum wallet"
	onClose={() =>
		appOrigin
			? goto(`${routes.CONNECT}?origin=${encodeURIComponent(appOrigin)}`)
			: goto(routes.HOME)}
>
	{#snippet content()}
		<Vertical --vertical-gap="var(--padding)">
			{#if error}
				<Vertical
					--vertical-gap="var(--half-padding)"
					style="background: #fee; padding: var(--padding); border-radius: 4px; border: 1px solid #fcc;"
				>
					<Typography variant="small" style="color: #c00;">Error</Typography>
					<Typography variant="small">{error}</Typography>
				</Vertical>
			{/if}

			<!-- Row 1 -->
			<Vertical --vertical-gap="var(--quarter-padding)">
				<Horizontal --horizontal-gap="var(--half-padding)">
					<FolderShared size={20} /><Typography>Account name</Typography>
				</Horizontal>
				<Input
					variant="outline"
					dimension="compact"
					name="account-name"
					bind:value={accountName}
					disabled={isProcessing}
				/>
			</Vertical>

			<!-- Row 2 -->
			<Vertical --vertical-gap="var(--quarter-padding)">
				<Typography>Secret seed</Typography>
				<Horizontal --horizontal-gap="var(--half-padding)">
					<div style="flex: 1" class="secret-seed-input">
						<Input
							variant="outline"
							dimension="compact"
							name="secret-seed"
							bind:value={secretSeed}
							error={secretSeedError}
							disabled={isProcessing}
						/>
					</div>
					<Button
						dimension="compact"
						variant="ghost"
						onclick={() => (showSeedModal = true)}
						disabled={isProcessing}
					>
						<WorkflowAutomation size={20} />
					</Button>
				</Horizontal>
				{#if secretSeedError}
					<ErrorMessage message={secretSeedError} />
				{:else}
					<Typography variant="small" class="accent"
						>Generate one with the button above on the right or use your own. <Tooltip
							show={showTooltip}
							position="top"
							variant="compact"
							color="dark"
							maxWidth="287px"
						>
							<!-- svelte-ignore a11y_invalid_attribute -->
							<a
								href="#"
								onmouseenter={() => (showTooltip = true)}
								onmouseleave={() => (showTooltip = false)}
								onclick={(e: MouseEvent) => {
									e.stopPropagation()
									showTooltip = !showTooltip
								}}>Learn more</a
							>
							{#snippet helperText()}
								The secret seed works with your ETH wallet to restore your Swarm ID account. <strong
									>Store it in a password manager or write it down and keep it in a secure location.
									Never share it with anyone.</strong
								>
							{/snippet}
						</Tooltip></Typography
					>
				{/if}
				{#if secretSeed && !secretSeedError}
					<Typography variant="small" style="color: var(--colors-red)"
						><strong>Warning:</strong> If you lose this seed, you won't be able to recover your account.</Typography
					>
				{/if}
			</Vertical>

			<!-- Row 3 -->
			<Vertical --vertical-gap="var(--quarter-padding)">
				<Horizontal
					--horizontal-gap="var(--half-padding)"
					--horizontal-justify-content="space-between"
				>
					<Typography>Authentication</Typography>
					<Horizontal --horizontal-gap="var(--half-padding)">
						<EthereumLogo size={16} />
						<Typography>Ethereum wallet</Typography>
					</Horizontal>
				</Horizontal>
			</Vertical>

			<Typography variant="small"
				>When you click "Connect wallet", you'll be able to connect via MetaMask (browser extension)
				or WalletConnect (mobile wallet via QR code). After connecting, you'll be prompted to sign a
				message. This signature will be used to derive your Swarm ID master key.</Typography
			>
		</Vertical>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={() => (showConfirmModal = true)} disabled={isFormDisabled}
			>{isProcessing ? 'Processing...' : 'Confirm and proceed'}
			{#if !isProcessing}<ArrowRight />{/if}</Button
		>
	{/snippet}
</CreationLayout>

<GenerateSeedModal bind:open={showSeedModal} onUseSeed={(seed) => (secretSeed = seed)} />
<ConfirmSaveModal bind:open={showConfirmModal} onConfirm={handleConfirm} />

<style>
	.secret-seed-input :global(.error-message) {
		display: none;
	}
</style>
