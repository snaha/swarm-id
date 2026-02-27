<script lang="ts">
	import { goto } from '$app/navigation'
	import { resolve } from '$app/paths'
	import { onMount } from 'svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import Select from '$lib/components/ui/select/select.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte'
	import Information from 'carbon-icons-svelte/lib/Information.svelte'
	import WarningAlt from 'carbon-icons-svelte/lib/WarningAlt.svelte'
	import routes from '$lib/routes'
	import { sessionStore } from '$lib/stores/session.svelte'
	import { accountsStore } from '$lib/stores/accounts.svelte'
	import { createAgentAccount, validateSeedPhrase, countSeedPhraseWords } from '$lib/agent-account'
	import { deriveAccountSwarmEncryptionKey } from '@swarm-id/lib'
	import type { AccountSyncType } from '$lib/types'

	let showTypeTooltip = $state(false)
	let accountName = $state('Agent')
	let accountType = $state<AccountSyncType>('local')
	let seedPhrase = $state('')
	let error = $state<string | undefined>(undefined)
	let isProcessing = $state(false)

	const accountTypeItems = [
		{ value: 'local', label: 'Local' },
		{ value: 'synced', label: 'Synced' },
	]

	onMount(() => {
		const accountNameIsTaken = accountsStore.accounts.some(
			(account) => account.name === accountName,
		)
		if (accountNameIsTaken) {
			accountName = `${accountName} ${accountsStore.accounts.filter((account) => account.type === 'agent').length + 1}`
		}
	})

	const wordCount = $derived(countSeedPhraseWords(seedPhrase))

	const seedPhraseValidation = $derived.by(() => {
		if (!seedPhrase.trim()) return undefined
		return validateSeedPhrase(seedPhrase)
	})

	const seedPhraseError = $derived.by(() => {
		if (!seedPhraseValidation) return undefined
		if (seedPhraseValidation.valid) return undefined
		return seedPhraseValidation.error
	})

	const isFormDisabled = $derived(
		!accountName.trim() || !seedPhrase.trim() || !!seedPhraseError || !seedPhraseValidation?.valid,
	)

	async function handleConfirm() {
		if (!accountName.trim()) {
			error = 'Please enter an account name'
			return
		}

		const validation = validateSeedPhrase(seedPhrase)
		if (!validation.valid) {
			error = validation.error
			return
		}

		try {
			isProcessing = true
			error = undefined
			console.log('Creating agent account...')

			// Create agent account from seed phrase using validated/normalized phrase
			const { account, masterKey } = createAgentAccount({
				name: accountName.trim(),
				seedPhrase: validation.phrase,
			})

			console.log('Agent account created with address:', account.id.toString())

			// Derive swarmEncryptionKey from master key
			const swarmEncryptionKey = await deriveAccountSwarmEncryptionKey(masterKey.toHex())
			console.log('SwarmEncryptionKey derived')

			// Store account (seed phrase is NOT stored - must be re-entered each time)
			const newAccount = accountsStore.addAccount({
				id: account.id,
				name: account.name,
				createdAt: account.createdAt,
				type: 'agent',
				swarmEncryptionKey,
			})
			sessionStore.setAccount(newAccount)
			sessionStore.setSyncedCreation(accountType === 'synced')

			// Keep masterKey in session temporarily for identity creation
			sessionStore.setTemporaryMasterKey(masterKey)
			console.log('MasterKey stored in session (temporary)')

			// Navigate to identity creation page
			goto(resolve(routes.IDENTITY_NEW))
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create agent account'
			console.error('Agent account creation failed:', err)
			isProcessing = false
		}
	}
</script>

<CreationLayout
	title="Sign up as Agent"
	description="Create an automated testing or programmatic account using a BIP39 seed phrase"
	onClose={() =>
		sessionStore.data.appOrigin ? goto(resolve(routes.CONNECT)) : goto(resolve(routes.HOME))}
>
	{#snippet content()}
		<Vertical --vertical-gap="var(--padding)">
			<div class="form-row">
				<div class="form-field account-name">
					<Input
						variant="outline"
						dimension="compact"
						name="account-name"
						bind:value={accountName}
						placeholder="Enter account name"
						disabled={isProcessing}
						label="Account name"
					/>
				</div>
				<div class="form-field account-type">
					<Select
						variant="outline"
						dimension="compact"
						label="Account type"
						bind:value={accountType}
						items={accountTypeItems}
					/>
				</div>
				<div class="info-button">
					<Tooltip
						show={showTypeTooltip}
						position="bottom"
						variant="small"
						color="dark"
						maxWidth="279px"
					>
						<Button
							dimension="compact"
							variant="ghost"
							onmouseenter={() => (showTypeTooltip = true)}
							onmouseleave={() => (showTypeTooltip = false)}
							onclick={(e: MouseEvent) => {
								e.stopPropagation()
								showTypeTooltip = !showTypeTooltip
							}}
						>
							<Information size={20} />
						</Button>
						{#snippet helperText()}
							Local accounts are free and faster to set up but are limited to viewing content on
							this device. Synced accounts enable uploading data and syncing across devices but
							require purchasing a Swarm postage stamp. <strong
								>Not sure yet? You can always upgrade from Local to Synced later.</strong
							>
						{/snippet}
					</Tooltip>
				</div>
			</div>

			<Vertical --vertical-gap="var(--quarter-padding)">
				<Horizontal --horizontal-justify-content="space-between">
					<Typography>BIP39 Seed Phrase</Typography>
					<Typography variant="small" class="word-count">{wordCount} words</Typography>
				</Horizontal>
				<textarea
					class="seed-phrase-input"
					bind:value={seedPhrase}
					placeholder="Enter your 12 or 24 word BIP39 mnemonic phrase..."
					rows="3"
					disabled={isProcessing}
				></textarea>
				{#if seedPhraseError}
					<ErrorMessage>{seedPhraseError}</ErrorMessage>
				{:else if !seedPhrase}
					<Typography variant="small" class="accent"
						>Enter a valid BIP39 mnemonic (12 or 24 words). The same phrase will always derive the
						same account address.</Typography
					>
				{:else if seedPhraseValidation?.valid}
					<Typography variant="small" style="color: var(--colors-green)"
						>Valid seed phrase</Typography
					>
				{/if}
			</Vertical>

			<Horizontal
				--horizontal-gap="var(--quarter-padding)"
				style="background: var(--colors-yellow-light); padding: var(--half-padding)"
			>
				<WarningAlt size={20} />
				<Typography variant="small"
					><strong>Security note:</strong> The seed phrase is never stored. You must re-enter it each
					time you authenticate with this account.</Typography
				>
			</Horizontal>

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
		<Button
			dimension="compact"
			onclick={handleConfirm}
			disabled={isFormDisabled || isProcessing}
			class="mobile-full-width"
		>
			<span class="desktop-only"><Checkmark size={20} /></span>
			{isProcessing ? 'Creating...' : 'Create Agent Account'}
			<span class="mobile-only"
				>{#if !isProcessing}<ArrowRight size={20} />{/if}</span
			>
		</Button>
	{/snippet}
</CreationLayout>

<style>
	.form-row {
		display: flex;
		gap: var(--half-padding);
		align-items: flex-end;
	}

	.form-field {
		flex: 1;
		min-width: 0;
	}

	.info-button {
		flex-shrink: 0;
	}

	.seed-phrase-input {
		width: 100%;
		padding: var(--half-padding);
		border: 1px solid var(--colors-low);
		border-radius: 4px;
		font-family: var(--typography-font-family-mono);
		font-size: var(--typography-font-size-base);
		resize: vertical;
		min-height: 80px;
	}

	.seed-phrase-input:focus {
		outline: none;
		border-color: var(--colors-high);
	}

	.seed-phrase-input:disabled {
		background: var(--colors-ultra-low);
		cursor: not-allowed;
	}

	:global(.word-count) {
		color: var(--colors-medium);
	}

	.desktop-only {
		display: inline-flex;
	}

	.mobile-only {
		display: none;
	}

	@media screen and (max-width: 640px) {
		.form-row {
			flex-wrap: wrap;
		}

		.account-name {
			width: 100%;
			flex: none;
		}

		.account-type {
			flex: 1;
		}

		.desktop-only {
			display: none;
		}

		.mobile-only {
			display: inline-flex;
		}

		:global(.mobile-full-width) {
			width: 100%;
			justify-content: center;
		}
	}
</style>
