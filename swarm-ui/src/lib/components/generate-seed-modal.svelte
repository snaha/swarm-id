<script lang="ts">
	import Modal from '$lib/components/ui/modal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import CopyButton from '$lib/components/copy-button.svelte'
	import { Renew } from 'carbon-icons-svelte'

	interface Props {
		open?: boolean
		onUseSeed?: (seed: string) => void
	}

	let { open = $bindable(false), onUseSeed }: Props = $props()

	let generatedSeed = $state('')

	function generateSecretSeed(): string {
		const length = 64 // Good balance between security and usability
		const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
		const lowercase = 'abcdefghijklmnopqrstuvwxyz'
		const numbers = '0123456789'
		const special = '!@#$%^&*()_+-=[]{}|;:,.<>?'
		const allChars = uppercase + lowercase + numbers + special

		// Helper to get cryptographically secure random index
		const getRandomIndex = (max: number) => {
			const randomBuffer = new Uint32Array(1)
			crypto.getRandomValues(randomBuffer)
			return randomBuffer[0] % max
		}

		// Ensure at least one of each required character type
		let seed = ''
		seed += uppercase[getRandomIndex(uppercase.length)]
		seed += lowercase[getRandomIndex(lowercase.length)]
		seed += numbers[getRandomIndex(numbers.length)]
		seed += special[getRandomIndex(special.length)]

		// Fill the rest randomly
		for (let i = seed.length; i < length; i++) {
			seed += allChars[getRandomIndex(allChars.length)]
		}

		// Shuffle the seed using Fisher-Yates algorithm with crypto random
		const chars = seed.split('')
		for (let i = chars.length - 1; i > 0; i--) {
			const j = getRandomIndex(i + 1)
			;[chars[i], chars[j]] = [chars[j], chars[i]]
		}

		return chars.join('')
	}

	function handleOpen() {
		generatedSeed = generateSecretSeed()
	}

	function handleUseSeed() {
		onUseSeed?.(generatedSeed)
		open = false
	}

	$effect(() => {
		if (open) {
			handleOpen()
		}
	})
</script>

<Modal bind:open>
	<Vertical --vertical-gap="var(--padding)" style="padding: var(--padding)">
		<Typography variant="h5">Generate secret seed</Typography>
		<Input variant="outline" dimension="compact" value={generatedSeed} label="Secret Seed" readonly>
			{#snippet buttons()}
				<CopyButton text={generatedSeed} />
				<Button
					dimension="compact"
					variant="ghost"
					onclick={() => {
						generatedSeed = generateSecretSeed()
					}}
				>
					<Renew size={20} />
				</Button>
			{/snippet}
		</Input>
		<Typography
			>The secret seed works with your ETH wallet to restore your Swarm ID account. <strong
				>Store it in a password manager or write it down and keep it in a secure location. Never
				share it with anyone.</strong
			></Typography
		>
		<Horizontal --horizontal-gap="var(--half-padding)">
			<Button dimension="compact" onclick={handleUseSeed}>Use this</Button>
			<Button dimension="compact" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		</Horizontal>
	</Vertical>
</Modal>
