// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Byte⇄hex conversion comes from the lib, which rejects malformed input.
import { hexToUint8Array } from '@snaha/swarm-id'

const V1_TIMESTAMP_BYTES = 8
const V1_REFERENCE_OFFSET = 8
const V1_PAYLOAD_SIZE = 40

/** A V1 feed payload: an 8-byte big-endian timestamp then a 32-byte reference. */
export function buildV1Payload(referenceHex: string, timestamp: number): Uint8Array {
  const timestampBytes = new Uint8Array(V1_TIMESTAMP_BYTES)
  const view = new DataView(timestampBytes.buffer)
  view.setBigUint64(0, BigInt(timestamp), false)

  const referenceBytes = hexToUint8Array(referenceHex)
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
