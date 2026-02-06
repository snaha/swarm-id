import { Binary } from "cafe-utility"

// secp256k1 curve parameters
const SECP256K1_P = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F",
)
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
)
const SECP256K1_GX = BigInt(
  "0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
)
const SECP256K1_GY = BigInt(
  "0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8",
)

// Key derivation nonces
const LOOKUP_KEY_NONCE = 0x00
const ACCESS_KEY_DECRYPTION_NONCE = 0x01

// Size constants
const PRIVATE_KEY_SIZE = 32
const PUBLIC_KEY_COORD_SIZE = 32
const COMPRESSED_PUBLIC_KEY_SIZE = 33
const KEY_SIZE = 32
const COUNTER_SIZE = 4

/**
 * Modular arithmetic: a mod p (always positive)
 */
function mod(a: bigint, p: bigint): bigint {
  const result = a % p
  return result >= 0n ? result : result + p
}

/**
 * Extended Euclidean algorithm for modular inverse
 */
function modInverse(a: bigint, p: bigint): bigint {
  let [oldR, r] = [mod(a, p), p]
  let [oldS, s] = [1n, 0n]

  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }

  if (oldR !== 1n) {
    throw new Error("Modular inverse does not exist")
  }

  return mod(oldS, p)
}

/**
 * Elliptic curve point addition on secp256k1
 * Returns null for point at infinity
 */
function ellipticAdd(
  x1: bigint,
  y1: bigint,
  x2: bigint,
  y2: bigint,
): [bigint, bigint] | null {
  // Handle point at infinity cases
  if (x1 === 0n && y1 === 0n) return [x2, y2]
  if (x2 === 0n && y2 === 0n) return [x1, y1]

  // If points are inverses, return point at infinity
  if (x1 === x2 && mod(y1 + y2, SECP256K1_P) === 0n) {
    return null
  }

  let slope: bigint
  if (x1 === x2 && y1 === y2) {
    // Point doubling
    const numerator = mod(3n * x1 * x1, SECP256K1_P)
    const denominator = mod(2n * y1, SECP256K1_P)
    slope = mod(numerator * modInverse(denominator, SECP256K1_P), SECP256K1_P)
  } else {
    // Point addition
    const numerator = mod(y2 - y1, SECP256K1_P)
    const denominator = mod(x2 - x1, SECP256K1_P)
    slope = mod(numerator * modInverse(denominator, SECP256K1_P), SECP256K1_P)
  }

  const x3 = mod(slope * slope - x1 - x2, SECP256K1_P)
  const y3 = mod(slope * (x1 - x3) - y1, SECP256K1_P)

  return [x3, y3]
}

/**
 * Elliptic curve point doubling (special case of addition)
 */
function ellipticDouble(x: bigint, y: bigint): [bigint, bigint] | null {
  return ellipticAdd(x, y, x, y)
}

/**
 * Scalar multiplication using double-and-add algorithm
 */
function scalarMultiply(
  px: bigint,
  py: bigint,
  scalar: bigint,
): [bigint, bigint] | null {
  if (scalar === 0n) return null

  let result: [bigint, bigint] | null = null
  let current: [bigint, bigint] | null = [px, py]

  let s = mod(scalar, SECP256K1_N)
  while (s > 0n) {
    if (s & 1n) {
      if (result === null) {
        result = current
      } else if (current !== null) {
        result = ellipticAdd(result[0], result[1], current[0], current[1])
      }
    }
    if (current !== null) {
      current = ellipticDouble(current[0], current[1])
    }
    s >>= 1n
  }

  return result
}

/**
 * Convert Uint8Array to bigint (big-endian)
 */
function uint8ArrayToBigInt(bytes: Uint8Array): bigint {
  let result = 0n
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

/**
 * Convert bigint to Uint8Array (big-endian, fixed size)
 */
function bigIntToUint8Array(value: bigint, size: number): Uint8Array {
  const result = new Uint8Array(size)
  let v = value
  for (let i = size - 1; i >= 0; i--) {
    result[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return result
}

/**
 * Derive public key from private key
 */
export function publicKeyFromPrivate(privKey: Uint8Array): {
  x: Uint8Array
  y: Uint8Array
} {
  if (privKey.length !== PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${PRIVATE_KEY_SIZE} bytes`)
  }

  const scalar = uint8ArrayToBigInt(privKey)
  const point = scalarMultiply(SECP256K1_GX, SECP256K1_GY, scalar)

  if (point === null) {
    throw new Error("Invalid private key")
  }

  return {
    x: bigIntToUint8Array(point[0], PUBLIC_KEY_COORD_SIZE),
    y: bigIntToUint8Array(point[1], PUBLIC_KEY_COORD_SIZE),
  }
}

/**
 * Compute ECDH shared secret (x-coordinate of shared point)
 */
export function ecdhSharedSecret(
  privKey: Uint8Array,
  pubX: Uint8Array,
  pubY: Uint8Array,
): Uint8Array {
  if (privKey.length !== PRIVATE_KEY_SIZE) {
    throw new Error(`Private key must be ${PRIVATE_KEY_SIZE} bytes`)
  }
  if (
    pubX.length !== PUBLIC_KEY_COORD_SIZE ||
    pubY.length !== PUBLIC_KEY_COORD_SIZE
  ) {
    throw new Error(
      `Public key coordinates must be ${PUBLIC_KEY_COORD_SIZE} bytes each`,
    )
  }

  const scalar = uint8ArrayToBigInt(privKey)
  const px = uint8ArrayToBigInt(pubX)
  const py = uint8ArrayToBigInt(pubY)

  const point = scalarMultiply(px, py, scalar)
  if (point === null) {
    throw new Error("ECDH computation resulted in point at infinity")
  }

  return bigIntToUint8Array(point[0], PUBLIC_KEY_COORD_SIZE)
}

/**
 * Derive lookup key and access key decryption key from ECDH shared secret
 */
export function deriveKeys(
  privKey: Uint8Array,
  pubX: Uint8Array,
  pubY: Uint8Array,
): { lookupKey: Uint8Array; accessKeyDecryptionKey: Uint8Array } {
  const sharedSecret = ecdhSharedSecret(privKey, pubX, pubY)

  // lookupKey = keccak256(sharedX || 0x00)
  const lookupKeyInput = new Uint8Array(sharedSecret.length + 1)
  lookupKeyInput.set(sharedSecret)
  lookupKeyInput[sharedSecret.length] = LOOKUP_KEY_NONCE
  const lookupKey = Binary.keccak256(lookupKeyInput)

  // accessKeyDecryptionKey = keccak256(sharedX || 0x01)
  const akdKeyInput = new Uint8Array(sharedSecret.length + 1)
  akdKeyInput.set(sharedSecret)
  akdKeyInput[sharedSecret.length] = ACCESS_KEY_DECRYPTION_NONCE
  const accessKeyDecryptionKey = Binary.keccak256(akdKeyInput)

  return { lookupKey, accessKeyDecryptionKey }
}

/**
 * Counter-mode encryption/decryption
 * Matches Bee's Go implementation (bee/pkg/encryption/encryption.go:134-168)
 * For each 32-byte block i: data[i] XOR keccak256(keccak256(key || uint32LE(i)))
 */
export function counterModeEncrypt(
  data: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) {
    throw new Error(`Key must be ${KEY_SIZE} bytes`)
  }

  const result = new Uint8Array(data.length)
  const numBlocks = Math.ceil(data.length / KEY_SIZE)

  for (let i = 0; i < numBlocks; i++) {
    // Create counter input: key || uint32LE(i)
    // Must match Bee's Go implementation which uses binary.LittleEndian.PutUint32
    const counterInput = new Uint8Array(key.length + COUNTER_SIZE)
    counterInput.set(key)
    // LITTLE ENDIAN counter (matches Bee's binary.LittleEndian.PutUint32)
    counterInput[key.length] = i & 0xff
    counterInput[key.length + 1] = (i >> 8) & 0xff
    counterInput[key.length + 2] = (i >> 16) & 0xff
    counterInput[key.length + 3] = (i >> 24) & 0xff

    // First hash: keccak256(key || counter)
    const ctrHash = Binary.keccak256(counterInput)

    // Second hash for "selective disclosure" (matches Bee's implementation)
    const keyStream = Binary.keccak256(ctrHash)

    // XOR data block with keystream
    const blockStart = i * KEY_SIZE
    const blockEnd = Math.min(blockStart + KEY_SIZE, data.length)

    for (let j = blockStart; j < blockEnd; j++) {
      result[j] = data[j] ^ keyStream[j - blockStart]
    }
  }

  return result
}

/**
 * Counter-mode decryption (symmetric with encryption)
 */
export const counterModeDecrypt = counterModeEncrypt

/**
 * Parse compressed public key (33 bytes) to uncompressed coordinates
 */
export function publicKeyFromCompressed(compressed: Uint8Array): {
  x: Uint8Array
  y: Uint8Array
} {
  if (compressed.length !== COMPRESSED_PUBLIC_KEY_SIZE) {
    throw new Error(
      `Compressed public key must be ${COMPRESSED_PUBLIC_KEY_SIZE} bytes`,
    )
  }

  const prefix = compressed[0]
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error("Invalid compressed public key prefix")
  }

  const x = uint8ArrayToBigInt(compressed.slice(1))

  // y² = x³ + 7 (mod p)
  const ySquared = mod(x * x * x + 7n, SECP256K1_P)

  // Compute modular square root using Tonelli-Shanks
  // For secp256k1, p ≡ 3 (mod 4), so y = (y²)^((p+1)/4) mod p
  const exponent = (SECP256K1_P + 1n) / 4n
  let y = modPow(ySquared, exponent, SECP256K1_P)

  // Check parity and adjust if needed
  const isEven = (y & 1n) === 0n
  const shouldBeEven = prefix === 0x02
  if (isEven !== shouldBeEven) {
    y = SECP256K1_P - y
  }

  return {
    x: bigIntToUint8Array(x, PUBLIC_KEY_COORD_SIZE),
    y: bigIntToUint8Array(y, PUBLIC_KEY_COORD_SIZE),
  }
}

/**
 * Compress public key to 33 bytes
 */
export function compressPublicKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  if (
    x.length !== PUBLIC_KEY_COORD_SIZE ||
    y.length !== PUBLIC_KEY_COORD_SIZE
  ) {
    throw new Error(
      `Public key coordinates must be ${PUBLIC_KEY_COORD_SIZE} bytes each`,
    )
  }

  const yBigInt = uint8ArrayToBigInt(y)
  const prefix = (yBigInt & 1n) === 0n ? 0x02 : 0x03

  const result = new Uint8Array(COMPRESSED_PUBLIC_KEY_SIZE)
  result[0] = prefix
  result.set(x, 1)

  return result
}

/**
 * Modular exponentiation using square-and-multiply
 */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  base = mod(base, modulus)

  while (exponent > 0n) {
    if (exponent & 1n) {
      result = mod(result * base, modulus)
    }
    exponent >>= 1n
    base = mod(base * base, modulus)
  }

  return result
}

/**
 * Generate a random 32-byte key using crypto.getRandomValues
 */
export function generateRandomKey(): Uint8Array {
  const key = new Uint8Array(KEY_SIZE)
  crypto.getRandomValues(key)
  return key
}
