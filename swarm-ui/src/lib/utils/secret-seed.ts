/**
 * Secret Seed Utilities
 *
 * Provides validation and generation logic for secret seeds used in Ethereum account creation.
 * Secret seeds must meet specific security requirements to ensure sufficient entropy.
 */

/**
 * Validate a secret seed against security requirements
 *
 * Requirements:
 * - Length: 20-128 characters
 * - At least one uppercase letter [A-Z]
 * - At least one lowercase letter [a-z]
 * - At least one number [0-9]
 * - At least one special character [^A-Za-z0-9]
 *
 * @param secretSeed - The secret seed to validate
 * @returns true if valid, false otherwise
 */
export function validateSecretSeed(secretSeed: string): boolean {
	const hasUppercase = /[A-Z]/.test(secretSeed)
	const hasLowercase = /[a-z]/.test(secretSeed)
	const hasNumber = /[0-9]/.test(secretSeed)
	const hasSpecialChar = /[^A-Za-z0-9]/.test(secretSeed)
	const isValidLength = secretSeed.length >= 20 && secretSeed.length <= 128

	return isValidLength && hasUppercase && hasLowercase && hasNumber && hasSpecialChar
}

/**
 * Generate a cryptographically secure secret seed
 *
 * Generates a secret seed using Apple-style pronounceable syllables with:
 * - 6 words (hyphen-separated)
 * - 2 syllables per word (consonant-vowel-consonant pattern)
 * - Random capitalization (10% probability)
 * - Random digit substitution (10% probability)
 *
 * The function validates each generated seed and retries until a valid one is produced.
 * Expected attempts: 1-3 (typically succeeds on first try).
 *
 * @returns A valid secret seed meeting all security requirements
 */
export function generateSecretSeed(): string {
	while (true) {
		const seed = generateSeedInternal()
		if (validateSecretSeed(seed)) {
			return seed
		}
	}
}

/**
 * Internal function to generate a single seed attempt
 */
function generateSeedInternal(): string {
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
