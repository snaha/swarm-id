<script lang="ts">
	import Modal from '$lib/components/ui/modal.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
	import Input from '$lib/components/ui/input/input.svelte'
	import Button from '$lib/components/ui/button.svelte'
	import Horizontal from '$lib/components/ui/horizontal.svelte'
	import CopyButton from '$lib/components/copy-button.svelte'
	import Renew from 'carbon-icons-svelte/lib/Renew.svelte'

	interface Props {
		open?: boolean
		onUseSeed?: (seed: string) => void
	}

	let { open = $bindable(false), onUseSeed }: Props = $props()

	let generatedSeed = $state('')

	function generateSecretSeed(): string {
		// Configuration - Apple-style seed generation with enhanced security
		const WORD_COUNT = 6 // Easy to adjust - more words = more entropy
		const SYLLABLES_PER_WORD = 2 // Consonant-vowel pairs per word
		const CAPITALIZATION_PROBABILITY = 0.1 // 10% of letters capitalized
		const DIGIT_SUBSTITUTION_PROBABILITY = 0.1 // 10% of letters become digits

		// Character sets (following Apple's approach)
		const CONSONANTS = 'bcdfghjkmnprstvxz'
		const VOWELS = 'aeiou'
		const DIGITS = '23456789'

		// Helper to get cryptographically secure random index
		const getRandomIndex = (max: number): number => {
			const randomBuffer = new Uint32Array(1)
			crypto.getRandomValues(randomBuffer)
			return randomBuffer[0] % max
		}

		// Helper to get random character from charset
		const getRandomChar = (charset: string): string => {
			return charset[getRandomIndex(charset.length)]
		}

		// Helper to check if crypto random passes probability threshold
		const randomPasses = (probability: number): boolean => {
			const randomBuffer = new Uint32Array(1)
			crypto.getRandomValues(randomBuffer)
			return randomBuffer[0] / 0xffffffff < probability
		}

		// Generate a syllable (consonant-vowel-consonant)
		const generateSyllable = (): string => {
			const consonant = getRandomChar(CONSONANTS)
			const vowel = getRandomChar(VOWELS)
			const consonant2 = getRandomChar(CONSONANTS)
			return consonant + vowel + consonant2
		}

		// Generate a word with syllables, capitalization, and digit substitution
		const generateWord = (): string => {
			// Generate base syllable-based word
			let word = ''
			for (let i = 0; i < SYLLABLES_PER_WORD; i++) {
				word += generateSyllable()
			}

			// Apply random capitalization and digit substitution
			const chars = word.split('')
			for (let i = 0; i < chars.length; i++) {
				// Random capitalization
				if (randomPasses(CAPITALIZATION_PROBABILITY)) {
					if (['o', 'i'].includes(chars[i])) {
						continue
					}
					chars[i] = chars[i].toUpperCase()
				}
				// Random digit substitution (only if still a letter)
				else if (randomPasses(DIGIT_SUBSTITUTION_PROBABILITY) && /[a-zA-Z]/.test(chars[i])) {
					chars[i] = getRandomChar(DIGITS)
				}
			}

			return chars.join('')
		}

		// Generate seed with configured number of words
		const words: string[] = []
		for (let i = 0; i < WORD_COUNT; i++) {
			words.push(generateWord())
		}

		return words.join('-')
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
