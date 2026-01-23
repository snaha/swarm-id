<script lang="ts">
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Modal from '$lib/components/ui/modal.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import { Close, View, ViewOff } from 'carbon-icons-svelte'
	import { deriveSecretSeedEncryptionKey, decryptSecretSeed } from '$lib/utils/encryption'
	import type { EthereumAccount } from '@swarm-id/lib'
	import CopyButton from './copy-button.svelte'
	import { type Bytes } from '@ethersphere/bee-js'
	import { getMasterKeyFromAccount } from '$lib/utils/account-auth'

	interface Props {
		open: boolean
		drawerOpen: boolean
		account: EthereumAccount
		onClose: () => void
	}

	let { open = $bindable(false), drawerOpen = $bindable(false), account, onClose }: Props = $props()

	let isUnmasked = $state(false)
	let secretSeed = $state('')
	let error = $state<string | undefined>(undefined)
	let isAuthenticating = $state(false)
	let decryptedMasterKey: Bytes | undefined

	async function handleAuthenticate() {
		if (!account) return

		try {
			open = false
			drawerOpen = false

			isAuthenticating = true
			error = undefined

			decryptedMasterKey = await getMasterKeyFromAccount(account)

			console.log('✅ Authentication successful')
		} catch (err) {
			error = err instanceof Error ? err.message : 'Authentication failed'
			console.error('❌ Authentication failed:', err)
		} finally {
			isAuthenticating = false
			open = true
			drawerOpen = true
		}
	}

	async function handleUnmask() {
		if (!decryptedMasterKey) {
			await handleAuthenticate()
		}

		try {
			if (decryptedMasterKey) {
				console.log('🔓 Decrypting secret seed...')

				// Derive encryption key from master key
				const secretSeedEncryptionKey = await deriveSecretSeedEncryptionKey(decryptedMasterKey)

				// Decrypt secret seed
				secretSeed = await decryptSecretSeed(account.encryptedSecretSeed, secretSeedEncryptionKey)

				isUnmasked = true
				console.log('✅ Secret seed decrypted')
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to decrypt secret seed'
			console.error('❌ Failed to decrypt secret seed:', err)
		}
	}

	function handleMask() {
		isUnmasked = false
		secretSeed = ''
	}

	function handleClose() {
		isUnmasked = false
		secretSeed = ''
		decryptedMasterKey = undefined
		error = undefined
		onClose()
	}
</script>

<Modal bind:open oncancel={handleClose}>
	<Vertical --vertical-gap="var(--padding)" style="padding: var(--padding)">
		<Horizontal --horizontal-justify-content="space-between">
			<Typography variant="h5">Generation Details</Typography>
			<Button variant="ghost" dimension="compact" onclick={handleClose}><Close size={24} /></Button>
		</Horizontal>

		<Vertical --vertical-gap="var(--padding)">
			<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="end">
				<Input
					variant="outline"
					dimension="compact"
					value={account.ethereumAddress.toHex()}
					class="grower"
					label="Initial wallet address"
					disabled
				/>
				<div style="border: 1px solid transparent">
					<CopyButton text={account.ethereumAddress.toHex()} />
				</div>
			</Horizontal>
			<Horizontal --horizontal-gap="var(--half-padding)" --horizontal-align-items="end">
				<Input
					variant="outline"
					dimension="compact"
					value={isUnmasked ? secretSeed : '***********************'}
					class="grower"
					label="Secret seed"
					disabled
					type={isUnmasked ? 'text' : 'password'}
				/>
				<div style="border: 1px solid transparent">
					{#if !isUnmasked}
						<Button
							dimension="compact"
							variant="ghost"
							onclick={handleUnmask}
							disabled={isAuthenticating}
							title="Unmask secret seed"
						>
							<View size={20} />
						</Button>
					{:else}
						<Button
							dimension="compact"
							variant="ghost"
							onclick={handleMask}
							title="Mask secret seed"
						>
							<ViewOff size={20} />
						</Button>
					{/if}
				</div>
			</Horizontal>
			<Typography>
				This secret seed is used in combination with your wallet to restore your Swarm ID account. <b
					>Store it in a password manager or write it down on a piece of paper hidden in a secure
					location. Never disclose it to anyone.</b
				>
			</Typography>
		</Vertical>

		{#if error}
			<Typography style="color: var(--colors-red)"
				>There was an error during authentication</Typography
			>
		{/if}

		<Horizontal --horizontal-gap="var(--padding)" --horizontal-justify-content="start">
			<Button dimension="compact" variant="strong" onclick={handleClose}>Close</Button>
		</Horizontal>
	</Vertical>
</Modal>
