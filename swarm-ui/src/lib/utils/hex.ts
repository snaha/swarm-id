import type { Bytes } from '@ethersphere/bee-js'

export type Hex = `0x${string}`

export function toPrefixedHex(bytes: Bytes): Hex {
	return `0x${bytes.toHex()}`
}
