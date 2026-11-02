// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The utilisation chunks themselves. Each chunk's encryption key is derived
 * from the account's `swarmEncryptionKey`, the chunk index and a small nonce.
 * The nonce is bumped only when an upload would land in the same bucket as a
 * lower-index chunk in the same save, so utilisation chunks spread over
 * distinct buckets and dedup stays stable across re-saves.
 */

import { type Stamper, BatchId, type Bee } from "@ethersphere/bee-js"
import { makeEncryptedContentAddressedChunk } from "../chunk"
import { Binary } from "cafe-utility"
import { uploadChunk, type UploadTarget } from "../proxy/upload"
import { tryCreateTag } from "../utils/tag"
import type { BatchUtilizationState } from "./state"
import { toBucket } from "./layout"

// ============================================================================
// Per-chunk Encryption Key Derivation
// ============================================================================

/** Domain-separation tag for utilisation-chunk key derivation. */
const UTIL_CHUNK_KEY_DOMAIN = "swarm-id-util-chunk-v1"

/** Length of the SHA-256 HMAC output in bytes (also the chunk key length). */
const KEY_LENGTH = 32

/** Bytes to encode `chunkIndex` and `nonce` (each big-endian uint32). */
const UINT32_BYTES = 4

/**
 * Resolved per-chunk-index encryption material.
 *
 * `nonce` is the smallest non-negative integer that placed the chunk in a
 * bucket distinct from every chunk with a lower `chunkIndex` during the
 * current save. `key` is the HMAC-derived 32-byte key used to produce the
 * encrypted-CAC address (and therefore the chunk's bucket).
 */
export interface UtilizationChunkKey {
  key: Uint8Array
  nonce: number
}

/**
 * Derive the per-chunk encryption key used for utilisation chunks.
 *
 * `chunkKey = HMAC-SHA256(swarmEncryptionKey, "swarm-id-util-chunk-v1" || batchId || chunkIndex || nonce)`
 *
 * Same inputs → same key, so dedup at the upload path stays stable across
 * re-saves whenever neither the plaintext nor the chosen nonce changes.
 */
export async function deriveUtilizationChunkKey(
  swarmEncryptionKey: Uint8Array,
  batchId: BatchId,
  chunkIndex: number,
  nonce: number,
): Promise<Uint8Array> {
  if (swarmEncryptionKey.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid swarmEncryptionKey length: ${swarmEncryptionKey.length} (expected ${KEY_LENGTH})`,
    )
  }

  const domain = new TextEncoder().encode(UTIL_CHUNK_KEY_DOMAIN)
  const batchIdBytes = batchId.toUint8Array()
  const indexBytes = new Uint8Array(UINT32_BYTES)
  new DataView(indexBytes.buffer).setUint32(0, chunkIndex, false)
  const nonceBytes = new Uint8Array(UINT32_BYTES)
  new DataView(nonceBytes.buffer).setUint32(0, nonce, false)
  const message = Binary.concatBytes(
    domain,
    batchIdBytes,
    indexBytes,
    nonceBytes,
  )

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    swarmEncryptionKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, message)
  return new Uint8Array(signature)
}

/**
 * Resolve the encryption key for a single utilisation chunk so it lands in a
 * bucket distinct from every other chunk in the same save, against a set of
 * already-claimed buckets. Mutates `claimedBuckets` to add the chosen one.
 *
 * Stability rule (matters for upload dedup): callers process chunks in
 * ascending `chunkIndex` order, and the first chunk to claim a bucket keeps
 * it. Each chunk starts its search from its `priorNonce`, so unchanged
 * plaintexts whose previously-chosen nonce still produces a distinct bucket
 * reuse the same key (and therefore the same CAC address) across saves —
 * dedup at `saveUtilizationState` then skips the upload.
 */
export async function chooseUtilizationChunkKey(args: {
  swarmEncryptionKey: Uint8Array
  batchId: BatchId
  chunkIndex: number
  plaintext: Uint8Array
  priorNonce: number
  claimedBuckets: Set<number>
}): Promise<{
  key: Uint8Array
  nonce: number
  bucket: number
  address: Uint8Array
}> {
  const { swarmEncryptionKey, batchId, chunkIndex, plaintext, claimedBuckets } =
    args
  let nonce = args.priorNonce
  while (true) {
    const key = await deriveUtilizationChunkKey(
      swarmEncryptionKey,
      batchId,
      chunkIndex,
      nonce,
    )
    const encrypted = makeEncryptedContentAddressedChunk(plaintext, key)
    const address = encrypted.address.toUint8Array()
    const bucket = toBucket(address)
    if (!claimedBuckets.has(bucket)) {
      claimedBuckets.add(bucket)
      return { key, nonce, bucket, address }
    }
    nonce++
  }
}

/**
 * Collect the set of buckets currently claimed by clean utilisation chunks
 * (those whose `contentHash` already reflects the upload). Dirty chunks
 * must steer clear of these buckets when picking a key.
 */
export function claimedBucketsForCleanChunks(
  state: BatchUtilizationState,
): Set<number> {
  const claimed = new Set<number>()
  for (const meta of state.chunks) {
    if (!meta.dirty && meta.contentHash) {
      claimed.add(toBucket(Binary.hexToUint8Array(meta.contentHash)))
    }
  }
  return claimed
}

// ============================================================================
// Chunk Upload/Download for Swarm Storage
// ============================================================================

/**
 * Upload an encrypted utilization chunk to Swarm as CAC
 *
 * Architecture: Just upload encrypted chunk data as CAC (immutable)
 *
 * @param bee - Bee client instance
 * @param stamper - Stamper for signing
 * @param data - Chunk data to upload (4KB)
 * @param encryptionKey - Encryption key (32 bytes)
 * @returns CAC reference
 */
export async function uploadUtilizationChunk(
  bee: Bee,
  stamper: Stamper,
  data: Uint8Array,
  encryptionKey: Uint8Array,
): Promise<Uint8Array> {
  // Validate inputs
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }
  if (encryptionKey.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid encryption key length: ${encryptionKey.length} (expected ${KEY_LENGTH})`,
    )
  }

  // Calculate CAC reference first (before upload)
  const encryptedChunk = makeEncryptedContentAddressedChunk(data, encryptionKey)
  const cacReference = encryptedChunk.address.toUint8Array()

  const tag = await tryCreateTag(bee)

  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper,
  }

  // Upload the exact encrypted bytes the reference was computed from —
  // re-encrypting would randomize the padding of sub-4096 plaintexts and
  // change the address (deferred: false for fast return)
  await uploadChunk(target, encryptedChunk.data, {
    deferred: false,
    tag,
  })

  return cacReference
}
