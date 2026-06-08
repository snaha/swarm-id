const ADJECTIVES = [
  'Jovial',
  'Curious',
  'Brave',
  'Gentle',
  'Witty',
  'Cosmic',
  'Radiant',
  'Nimble',
  'Lucid',
  'Serene',
  'Bold',
  'Clever',
]

const SCIENTISTS = [
  'Einstein',
  'Curie',
  'Newton',
  'Tesla',
  'Lovelace',
  'Darwin',
  'Bohr',
  'Turing',
  'Hopper',
  'Franklin',
  'Noether',
  'Feynman',
]

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

/** Generate a friendly, human-readable default identity name. */
export function generateName(): string {
  return `${pick(ADJECTIVES)} ${pick(SCIENTISTS)}`
}
