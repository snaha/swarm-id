// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Byte encodings of the per-bucket counter arrays. */

/** uint16 serialization size in bytes */
export const COUNTER_BYTES_UINT16 = 2

/** uint32 serialization size in bytes */
export const COUNTER_BYTES_UINT32 = 4

/** Largest value representable in an unsigned 16-bit integer */
const UINT16_MAX = 0xffff

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize Uint32Array to bytes (little-endian)
 */
export function serializeUint32Array(arr: Uint32Array): Uint8Array {
  const buffer = new ArrayBuffer(arr.length * 4)
  const view = new DataView(buffer)

  for (let i = 0; i < arr.length; i++) {
    view.setUint32(i * 4, arr[i], true) // true = little-endian
  }

  return new Uint8Array(buffer)
}

/**
 * Deserialize bytes to Uint32Array (little-endian)
 */
export function deserializeUint32Array(bytes: Uint8Array): Uint32Array {
  if (bytes.length % 4 !== 0) {
    throw new Error("Byte array length must be a multiple of 4")
  }

  const arr = new Uint32Array(bytes.length / 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  for (let i = 0; i < arr.length; i++) {
    arr[i] = view.getUint32(i * 4, true) // true = little-endian
  }

  return arr
}

/**
 * Serialize a Uint32Array to bytes as little-endian uint16 values.
 *
 * Counters exceeding uint16 throw — callers must use the uint32 codec
 * (i.e. batchDepth >= UINT16_COUNTER_MAX_DEPTH + 1) for those depths.
 */
export function serializeUint16Array(arr: Uint32Array): Uint8Array {
  const buffer = new ArrayBuffer(arr.length * COUNTER_BYTES_UINT16)
  const view = new DataView(buffer)

  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (v > UINT16_MAX) {
      throw new Error(
        `Counter at index ${i} (${v}) exceeds uint16 range; use uint32 codec`,
      )
    }
    view.setUint16(i * COUNTER_BYTES_UINT16, v, true) // true = little-endian
  }

  return new Uint8Array(buffer)
}

/**
 * Deserialize little-endian uint16 bytes back into a Uint32Array (the
 * in-memory representation stays uint32 even when the on-disk codec is
 * narrower).
 */
export function deserializeUint16Array(bytes: Uint8Array): Uint32Array {
  if (bytes.length % COUNTER_BYTES_UINT16 !== 0) {
    throw new Error("Byte array length must be a multiple of 2")
  }

  const arr = new Uint32Array(bytes.length / COUNTER_BYTES_UINT16)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  for (let i = 0; i < arr.length; i++) {
    arr[i] = view.getUint16(i * COUNTER_BYTES_UINT16, true) // true = little-endian
  }

  return arr
}
