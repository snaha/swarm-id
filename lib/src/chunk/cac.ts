// Content-addressed chunk (CAC) utilities

import { Binary } from "cafe-utility"
import { Bytes, Reference, Span } from "@ethersphere/bee-js"
import { calculateChunkAddress } from "./bmt"
import { MAX_PAYLOAD_SIZE, MIN_PAYLOAD_SIZE } from "./constants"

const ENCODER = new TextEncoder()

/**
 * Content addressed chunk interface
 */
export interface ContentAddressedChunk {
  readonly data: Uint8Array // span + payload
  readonly span: Span
  readonly payload: Bytes
  readonly address: Reference // BMT hash
}

/**
 * Creates a content addressed chunk from payload data
 *
 * @param payloadBytes the data to be stored in the chunk (1-4096 bytes)
 * @param spanOverride optional span value to use instead of payload length
 */
export function makeContentAddressedChunk(
  payloadBytes: Uint8Array | string,
  spanOverride?: Span | bigint,
): ContentAddressedChunk {
  if (!(payloadBytes instanceof Uint8Array)) {
    payloadBytes = ENCODER.encode(payloadBytes)
  }

  if (
    payloadBytes.length < MIN_PAYLOAD_SIZE ||
    payloadBytes.length > MAX_PAYLOAD_SIZE
  ) {
    throw new RangeError(
      `payload size ${payloadBytes.length} exceeds limits [${MIN_PAYLOAD_SIZE}, ${MAX_PAYLOAD_SIZE}]`,
    )
  }

  // Determine span value
  let span: Span
  if (spanOverride instanceof Span) {
    span = spanOverride
  } else if (typeof spanOverride === "bigint") {
    span = Span.fromBigInt(spanOverride)
  } else {
    span = Span.fromBigInt(BigInt(payloadBytes.length))
  }

  // Create chunk data (span + payload)
  const chunkData = Binary.concatBytes(span.toUint8Array(), payloadBytes)

  // Calculate BMT address
  const address = calculateChunkAddress(chunkData)

  return {
    data: chunkData,
    span,
    payload: new Bytes(payloadBytes),
    address,
  }
}
