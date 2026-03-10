export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return bytes
}

const V1_TIMESTAMP_BYTES = 8
const V1_REFERENCE_OFFSET = 8
const V1_PAYLOAD_SIZE = 40

export function buildV1Payload(referenceHex: string, timestamp: number): Uint8Array {
  const timestampBytes = new Uint8Array(V1_TIMESTAMP_BYTES)
  const view = new DataView(timestampBytes.buffer)
  view.setBigUint64(0, BigInt(timestamp), false)

  const referenceBytes = hexToBytes(referenceHex)
  const EXPECTED_REFERENCE_BYTES = 32
  if (referenceBytes.length !== EXPECTED_REFERENCE_BYTES) {
    throw new Error(
      `Reference must be exactly ${EXPECTED_REFERENCE_BYTES} bytes (64 hex chars), got ${referenceBytes.length} bytes. Encrypted references (128 hex chars) are not supported in V1 feed payloads.`,
    )
  }

  const payload = new Uint8Array(V1_PAYLOAD_SIZE)
  payload.set(timestampBytes, 0)
  payload.set(referenceBytes, V1_REFERENCE_OFFSET)
  return payload
}
