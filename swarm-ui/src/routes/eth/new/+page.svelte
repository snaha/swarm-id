<script lang="ts">
	import PasskeyLogo from '$lib/components/passkey-logo.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import { authenticateWithPasskey } from '$lib/passkey'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import BxRightArrowAlt from '$lib/components/boxicons/bx-right-arrow-alt.svelte'
	import { FolderShared, WorkflowAutomation } from 'carbon-icons-svelte'
	import routes from '$lib/routes'
	import CreationLayout from '$lib/components/creation-layout.svelte'
	import Grid from '$lib/components/ui/grid.svelte'
	import { goto } from '$app/navigation'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import EthereumLogo from '$lib/components/ethereum-logo.svelte'
	import Tooltip from '$lib/components/ui/tooltip.svelte'
	import ErrorMessage from '$lib/components/ui/error-message.svelte'
	import GenerateSeedModal from '$lib/components/generate-seed-modal.svelte'
	import ConfirmSaveModal from '$lib/components/confirm-save-modal.svelte'

	let showTooltip = $state(false)
	let showSeedModal = $state(false)
	let showConfirmModal = $state(false)
	let accountName = $state('Ethereum')
	let secretSeed = $state('')

	let secretSeedError = $derived.by(() => {
		if (!secretSeed) return undefined

		const hasUppercase = /[A-Z]/.test(secretSeed)
		const hasLowercase = /[a-z]/.test(secretSeed)
		const hasNumber = /[0-9]/.test(secretSeed)
		const hasSpecialChar = /[^A-Za-z0-9]/.test(secretSeed)
		const isValidLength = secretSeed.length >= 20 && secretSeed.length <= 128

		if (!isValidLength || !hasUppercase || !hasLowercase || !hasNumber || !hasSpecialChar) {
			return 'Use 20 to 128 characters with a mix of uppercase letters, lowercase letters, numbers, and special characters.'
		}

		return undefined
	})

	let isFormDisabled = $derived(!accountName || !secretSeed || !!secretSeedError)

	async function handlePasskeyConnect() {
		try {
			console.log('🔐 Authenticating with passkey...')
			const identity = await authenticateWithPasskey({
				rpId: window.location.hostname,
			})

			console.log('✅ Passkey authenticated successfully')
			console.log('Credential ID:', identity.credentialId)
			console.log('PRF Available:', identity.prfAvailable)
			if (identity.prfOutput) {
				console.log(
					'PRF Output (hex):',
					Array.from(identity.prfOutput.slice(0, 8))
						.map((b) => b.toString(16).padStart(2, '0'))
						.join('') + '...',
				)
			}
			console.log('Ethereum Address:', identity.ethereumAddress)
		} catch (error) {
			console.error('❌ Passkey authentication failed:', error)
			if (error instanceof Error) {
				console.error('Error message:', error.message)
			}
		}
	}
</script>

<CreationLayout
	title="Create account"
	description="Create a new Swarm ID account"
	onClose={() => goto(routes.HOME)}
>
	{#snippet content()}
		<Vertical --vertical-gap="var(--padding)">
			<!-- Row 1 -->
			<Vertical --vertical-gap="var(--quarter-padding)">
				<Horizontal --horizontal-gap="var(--half-padding)">
					<FolderShared size={20} /><Typography>Account name</Typography>
				</Horizontal>
				<Input variant="outline" dimension="compact" name="account-name" bind:value={accountName} />
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
						/>
					</div>
					<Button dimension="compact" variant="ghost" onclick={() => (showSeedModal = true)}>
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
							{#snippet children()}
								<a
									href="#"
									onmouseenter={() => (showTooltip = true)}
									onmouseleave={() => (showTooltip = false)}
									onclick={(e) => e.preventDefault()}>Learn more</a
								>
							{/snippet}
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
		</Vertical>
	{/snippet}

	{#snippet buttonContent()}
		<Button dimension="compact" onclick={() => (showConfirmModal = true)} disabled={isFormDisabled}
			>Confirm and proceed <BxRightArrowAlt /></Button
		>
	{/snippet}
</CreationLayout>

<GenerateSeedModal bind:open={showSeedModal} onUseSeed={(seed) => (secretSeed = seed)} />
<ConfirmSaveModal bind:open={showConfirmModal} onConfirm={() => goto(routes.IDENTITY_NEW)} />

<style>
	.secret-seed-input :global(.error-message) {
		display: none;
	}
</style>
