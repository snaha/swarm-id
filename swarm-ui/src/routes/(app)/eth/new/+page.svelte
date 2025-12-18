<script lang="ts">
	import { goto } from '$app/navigation'
	import Typography from '$lib/components/ui/typography.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import WorkflowAutomation from 'carbon-icons-svelte/lib/WorkflowAutomation.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import GenerateSeedModal from '$lib/components/generate-seed-modal.svelte'
	import { connectAndSign, deriveMasterKey } from '$lib/ethereum'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import {
		generateEncryptionSalt,
		deriveEncryptionKey,
		encryptMasterKey,
	} from '$lib/utils/encryption'
	import { uint8ArrayToHex } from '$lib/utils/key-derivation'
	import { validateSecretSeed } from '$lib/utils/secret-seed'
	import { WarningAlt } from 'carbon-icons-svelte'
	import Confirmation from '$lib/components/confirmation.svelte'
	import { onMount } from 'svelte'

	let showTooltip = $state(false)
	let showSeedModal = $state(false)
	let accountName = $state('Ethereum')
	let secretSeed = $state('')
	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	onMount(() => {
		const accountNameIsTaken = accountsStore.accounts.some(
			(account) => account.name === accountName,
		)
		if (accountNameIsTaken) {
			accountName = `${accountName} ${accountsStore.accounts.filter((account) => account.type === 'ethereum').length + 1}`
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
			const signed = await connectAndSign()

			console.log('✅ Wallet connected and message signed')
			console.log('📍 Wallet address:', signed.address)

			const { masterKey, masterAddress } = deriveMasterKey(secretSeed, signed.publicKey)

			// Encrypt masterKey before storage
			console.log('🔒 Encrypting masterKey...')

			// Step 2: Generate encryption salt
			const encryptionSalt = uint8ArrayToHex(generateEncryptionSalt())
			console.log('🎲 Encryption salt generated')

			// Step 3: Derive encryption key from public key + salt
			const encryptionKey = await deriveEncryptionKey(signed.publicKey, encryptionSalt)
			console.log('🔑 Encryption key derived')

			// Step 4: Encrypt masterKey
			const encryptedMasterKey = await encryptMasterKey(masterKey, encryptionKey)
			console.log('✅ MasterKey encrypted')

			// Store account with encrypted masterKey
			const newAccount = accountsStore.addAccount({
				id: masterAddress,
				createdAt: Date.now(),
				name: accountName.trim(),
				type: 'ethereum',
				ethereumAddress: signed.address,
				encryptedMasterKey: encryptedMasterKey,
				encryptionSalt: encryptionSalt,
			})
			sessionStore.setAccount(newAccount)

			// Keep unencrypted masterKey in session temporarily for identity creation
			sessionStore.setTemporaryMasterKey(masterKey)
			console.log('🔑 MasterKey stored in session (temporary)')

			// Navigate to identity creation page
			goto(routes.IDENTITY_NEW)
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect wallet'
			console.error('❌ Wallet connection failed:', err)
			console.error(error)
			isProcessing = false
		}
	}
</script>

{#if isProcessing}
	<Confirmation authenticationType="ethereum" />
{:else}
	<CreationLayout
		title="Create account with Ethereum"
		description="Create a new Swarm ID account using an Ethereum wallet"
		onClose={() => (sessionStore.data.appOrigin ? goto(routes.CONNECT) : goto(routes.HOME))}
	>
		{#snippet content()}
			<Vertical --vertical-gap="var(--padding)">
				<!-- Row 1 -->
				<Vertical --vertical-gap="var(--quarter-padding)">
					<Horizontal --horizontal-gap="var(--half-padding)">
						<Typography>Account name</Typography>
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
						<ErrorMessage>{secretSeedError}</ErrorMessage>
					{:else}
						<Typography variant="small" class="accent"
							>Generate one with the button above on the right or use your own. <Tooltip
								show={showTooltip}
								position="top"
								variant="small"
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
										>Store it in a password manager or write it down and keep it in a secure
										location. Never share it with anyone.</strong
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

				{#if error}
					<Horizontal
						--horizontal-gap="var(--quarter-padding)"
						style="background: var(--colors-red); padding: var(--half-padding); color: var(--colors-ultra-low)"
					>
						<WarningAlt size={20} />
						<Typography --typography-color="var(--colors-ultra-low)">{error}</Typography>
					</Horizontal>
				{/if}
			</Vertical>
		{/snippet}

		{#snippet buttonContent()}
			<Button dimension="compact" onclick={handleConfirm} disabled={isFormDisabled}
				>{isProcessing ? 'Processing...' : 'Confirm with wallet'}
				{#if !isProcessing}<ArrowRight />{/if}</Button
			>
		{/snippet}
	</CreationLayout>
{/if}

<GenerateSeedModal bind:open={showSeedModal} onUseSeed={(seed) => (secretSeed = seed)} />

<style>
	.secret-seed-input :global(.error-message) {
		display: none;
	}
</style>
