// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified upload API for Swarm data uploads.
 *
 * This module provides a single entry point for all upload operations:
 * - Plain or encrypted data uploads
 * - Stamper-based (user has postage batch) or subsidised gateway (gateway handles stamps)
 * - HTTP or WebSocket transport
 *
 * Usage:
 *   const target: UploadTarget = { mode: "stamper", bee, stamper }
 *   const result = await uploadData(target, data, { encryptionKey: true })
 */

import { Reference, PrivateKey, Identifier, Span } from "@ethersphere/bee-js"
import type {
  Bee,
  BeeRequestOptions,
  Stamper,
  UploadOptions,
  EnvelopeWithBatchId,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import {
  makeContentAddressedChunk,
  makeEncryptedContentAddressedChunk,
  calculateChunkAddress,
  newChunkEncrypter,
  type ContentAddressedChunk,
  type EncryptedChunk,
  DEFAULT_UPLOAD_CONCURRENCY,
} from "../chunk"
import { splitDataIntoChunks, CHUNK_SIZE, REFS_PER_CHUNK } from "./chunking"
import { ENCRYPTED_REFS_PER_CHUNK } from "./chunking-encrypted"
import { ChunkUploadStream } from "./chunk-upload-stream"
import { marshalEnvelope } from "./stamp-marshal"
import type { ChunkReference, UploadProgress } from "./types"
import type { StampWorkerPool } from "./stamp-worker-pool"
import { tryCreateTag } from "../utils/tag"
import { uint8ArrayToHex } from "../utils/hex"
import { normalizeUrl } from "../utils/url"

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when a SOC upload gets a non-OK HTTP response. Carries the numeric
 * `status` so callers can distinguish a definitive stamp rejection (400) from a
 * transient / not-yet-synced condition (404 "batch not found", 422 "not usable
 * yet") without regex-matching the message — see `verifyBatchStampable`.
 */
export class SocUploadError extends Error {
  readonly status: number

  constructor(status: number, statusText: string, body: string) {
    super(`SOC upload failed: ${status} ${statusText} - ${body}`)
    this.name = "SocUploadError"
    this.status = status
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Upload target: stamper-based (user has postage batch) or subsidised gateway
 */
export type UploadTarget =
  | {
      mode: "stamper"
      bee: Bee
      stamper: Stamper
      workerPool?: StampWorkerPool
    }
  | {
      mode: "subsidised"
      gatewayUrl: string
    }

/**
 * Type guard for stamper target
 */
export function isStamperTarget(
  target: UploadTarget,
): target is UploadTarget & { mode: "stamper" } {
  return target.mode === "stamper"
}

/**
 * Type guard for subsidised target
 */
export function isSubsidisedTarget(
  target: UploadTarget,
): target is UploadTarget & { mode: "subsidised" } {
  return target.mode === "subsidised"
}

/**
 * Unified options for data upload
 */
export interface UploadDataOptions {
  /**
   * Encryption key: undefined = plain, Uint8Array = use this key, true =
   * auto-generate. An explicit key only applies to single-chunk data
   * (≤ 4096 bytes); larger data throws — pass true instead.
   */
  encryptionKey?: Uint8Array | true
  /** Pin the uploaded data */
  pin?: boolean
  /** Use deferred upload mode */
  deferred?: boolean
  /** Tag for tracking upload progress */
  tag?: number
  /** WebSocket upload options (stamper mode only) */
  webSocket?: { concurrency?: number }
  /** HTTP concurrency for parallel uploads */
  httpConcurrency?: number
  /** Progress callback */
  onProgress?: (progress: UploadProgress) => void
  /** Bee request options (stamper mode only) */
  requestOptions?: BeeRequestOptions
}

/**
 * Result of uploading data
 */
export interface UploadDataResult {
  /** Reference to the uploaded data (32-byte hex for plain, 64-byte for encrypted) */
  reference: string
  /** Tag UID if one was created */
  tagUid?: number
  /** Addresses of all uploaded chunks (encrypted mode only) */
  chunkAddresses?: Uint8Array[]
}

/**
 * Options for SOC upload
 */
export interface UploadSOCOptions {
  /** Encryption key: undefined = plain SOC, Uint8Array = use this key, true = auto-generate */
  encryptionKey?: Uint8Array | true
  /** Pin the uploaded SOC */
  pin?: boolean
  /** Use deferred upload mode */
  deferred?: boolean
  /** Tag for tracking */
  tag?: number
  /** Bee request options (stamper mode only) */
  requestOptions?: BeeRequestOptions
}

/**
 * Result of uploading a SOC
 */
export interface UploadSOCResult {
  /** SOC address (32 bytes) */
  socAddress: Uint8Array
  /** Encryption key (only for encrypted SOCs) */
  encryptionKey?: Uint8Array
  /** Tag UID if one was created */
  tagUid?: number
}

/**
 * Options for single chunk upload
 */
export interface UploadChunkOptions {
  /** Pin the uploaded chunk */
  pin?: boolean
  /** Use deferred upload mode */
  deferred?: boolean
  /** Tag for tracking */
  tag?: number
  /** Bee request options (stamper mode only) */
  requestOptions?: BeeRequestOptions
}

/**
 * Result of uploading a chunk
 */
export interface UploadChunkResult {
  /** Chunk reference (address) */
  reference: string
}

// ============================================================================
// Internal Utilities
// ============================================================================

/**
 * Simple Uint8ArrayWriter - minimal stub required by Stamper interface.
 * The Stamper interface requires a writer field but never calls it during stamp().
 */
class SimpleUint8ArrayWriter {
  cursor: number = 0
  buffer: Uint8Array

  constructor(buffer: Uint8Array) {
    this.buffer = buffer
  }

  write(_reader: unknown): number {
    throw new Error("SimpleUint8ArrayWriter.write() not implemented")
  }

  max(): number {
    return this.buffer.length
  }
}

/**
 * Stamp chunk data by address and return the envelope.
 */
function stampChunkData(
  stamper: Stamper,
  chunkData: Uint8Array,
  address: Uint8Array,
): EnvelopeWithBatchId {
  return stamper.stamp({
    hash: () => address,
    build: () => chunkData,
    span: 0n,
    writer: new SimpleUint8ArrayWriter(chunkData),
  })
}

/**
 * Async stamp function - abstraction over sync Stamper and parallel StampWorkerPool.
 */
type StampChunkFn = (
  chunkData: Uint8Array,
  address: Uint8Array,
) => Promise<EnvelopeWithBatchId>

/**
 * Create a StampChunkFn from a Stamper and optional worker pool.
 */
function makeStampFn(
  stamper: Stamper,
  workerPool?: StampWorkerPool,
): StampChunkFn {
  if (workerPool) {
    return (chunkData, address) => workerPool.stampChunkData(chunkData, address)
  }
  return (chunkData, address) =>
    Promise.resolve(stampChunkData(stamper, chunkData, address))
}

// ============================================================================
// Encrypted Chunk Helpers
// ============================================================================

interface EncryptedChunkRef {
  address: Uint8Array
  key: Uint8Array
  span: bigint
}

/**
 * Encrypt all payloads into EncryptedChunks and collect their references.
 *
 * An explicit key is only valid for a single payload: every chunk of a
 * multi-chunk upload carries its own key, so honouring one shared key is
 * impossible and substituting random keys would silently break the caller's
 * expectation of a key-addressed reference.
 */
function encryptChunkPayloads(
  payloads: Uint8Array[],
  encryptionKey?: Uint8Array,
): { chunks: EncryptedChunk[]; refs: EncryptedChunkRef[] } {
  if (encryptionKey && payloads.length > 1) {
    throw new Error(
      `Explicit encryption key is only supported for single-chunk data (up to ${CHUNK_SIZE} bytes), got ${payloads.length} chunks — pass encryptionKey: true to auto-generate per-chunk keys`,
    )
  }

  const chunks: EncryptedChunk[] = []
  const refs: EncryptedChunkRef[] = []

  for (const payload of payloads) {
    const chunk = makeEncryptedContentAddressedChunk(payload, encryptionKey)
    chunks.push(chunk)
    refs.push({
      address: chunk.address.toUint8Array(),
      key: chunk.encryptionKey,
      span: BigInt(payload.length),
    })
  }

  return { chunks, refs }
}

// ============================================================================
// HTTP Transport
// ============================================================================

/**
 * Upload a single stamped chunk via HTTP (stamper mode).
 */
async function uploadStampedChunkViaHttp(
  bee: Bee,
  stamp: StampChunkFn,
  chunkData: Uint8Array,
  address: Uint8Array,
  options: UploadOptions,
  requestOptions?: BeeRequestOptions,
): Promise<void> {
  const envelope = await stamp(chunkData, address)
  await bee.uploadChunk(envelope, chunkData, options, requestOptions)
}

/**
 * Upload a chunk via subsidised gateway (no stamp required).
 */
async function uploadChunkViaSubsidisedGatewayInternal(
  gatewayUrl: string,
  chunkData: Uint8Array,
  options?: { pin?: boolean; deferred?: boolean },
): Promise<{ reference: string }> {
  const url = `${normalizeUrl(gatewayUrl)}/chunks`

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }

  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: chunkData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Subsidised chunk upload failed: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  const result = await response.json()
  return { reference: result.reference }
}

/**
 * Upload multiple chunks via HTTP with sliding-window concurrency.
 */
async function uploadChunksViaHttp(
  bee: Bee,
  stamp: StampChunkFn,
  chunks: Array<{ data: Uint8Array; address: Uint8Array }>,
  options: UploadOptions,
  requestOptions: BeeRequestOptions | undefined,
  onUploaded: (address: Uint8Array) => void,
  concurrency: number = DEFAULT_UPLOAD_CONCURRENCY,
): Promise<void> {
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < chunks.length) {
      const chunk = chunks[nextIndex++]
      await uploadStampedChunkViaHttp(
        bee,
        stamp,
        chunk.data,
        chunk.address,
        options,
        requestOptions,
      )
      onUploaded(chunk.address)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () =>
      worker(),
    ),
  )
}

// ============================================================================
// WebSocket Transport
// ============================================================================

/**
 * Upload a single stamped chunk via WebSocket.
 */
async function uploadStampedChunkViaWebSocket(
  stamp: StampChunkFn,
  stream: ChunkUploadStream,
  chunkData: Uint8Array,
  address: Uint8Array,
): Promise<void> {
  const envelope = await stamp(chunkData, address)
  const stamped = Binary.concatBytes(marshalEnvelope(envelope), chunkData)
  await stream.uploadChunk(stamped)
}

/**
 * Upload multiple chunks via WebSocket with per-chunk stamping.
 */
async function uploadChunksViaWebSocket(
  stamp: StampChunkFn,
  stream: ChunkUploadStream,
  chunks: Array<{ data: Uint8Array; address: Uint8Array }>,
  onUploaded: (address: Uint8Array) => void,
): Promise<void> {
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < chunks.length) {
      const chunk = chunks[nextIndex++]
      await uploadStampedChunkViaWebSocket(
        stamp,
        stream,
        chunk.data,
        chunk.address,
      )
      onUploaded(chunk.address)
    }
  }

  const workerCount = stream.getConcurrency()
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}

// ============================================================================
// Merkle Tree Building
// ============================================================================

/**
 * Build merkle tree from plain chunk references.
 * Returns 32-byte root reference.
 */
async function buildPlainMerkleTree(
  chunkRefs: ChunkReference[],
  uploadIntermediate: (chunk: ContentAddressedChunk) => Promise<void>,
): Promise<Reference> {
  if (chunkRefs.length === 1) {
    return new Reference(chunkRefs[0].address)
  }

  const intermediateRefs: ChunkReference[] = []

  for (let i = 0; i < chunkRefs.length; i += REFS_PER_CHUNK) {
    const refs = chunkRefs.slice(
      i,
      Math.min(i + REFS_PER_CHUNK, chunkRefs.length),
    )

    // Build payload with 32-byte references
    const payload = new Uint8Array(refs.length * 32)
    refs.forEach((ref, idx) => {
      payload.set(ref.address, idx * 32)
    })

    // An intermediate chunk's span is the total data length covered by its
    // children, not the length of its references payload. The downloader
    // relies on this to tell intermediate chunks from leaves.
    const totalSpan = refs.reduce((sum, ref) => sum + (ref.span ?? 0n), 0n)

    const chunk = makeContentAddressedChunk(payload, totalSpan)
    intermediateRefs.push({
      address: chunk.address.toUint8Array(),
      span: totalSpan,
    })
    await uploadIntermediate(chunk)
  }

  if (intermediateRefs.length > 1) {
    return buildPlainMerkleTree(intermediateRefs, uploadIntermediate)
  }

  return new Reference(intermediateRefs[0].address)
}

/**
 * Build merkle tree from encrypted chunk references.
 * Returns 64-byte root reference (address + encryption key).
 */
async function buildEncryptedMerkleTree(
  refs: EncryptedChunkRef[],
  uploadIntermediate: (chunkData: Uint8Array) => Promise<void>,
): Promise<Reference> {
  if (refs.length === 1) {
    const ref = new Uint8Array(64)
    ref.set(refs[0].address, 0)
    ref.set(refs[0].key, 32)
    return new Reference(ref)
  }

  const intermediateChunks: EncryptedChunkRef[] = []

  for (let i = 0; i < refs.length; i += ENCRYPTED_REFS_PER_CHUNK) {
    const batch = refs.slice(
      i,
      Math.min(i + ENCRYPTED_REFS_PER_CHUNK, refs.length),
    )

    // Pass through single-ref batches without wrapping in an intermediate.
    // A ghost intermediate with span ≤ 4096 would be misidentified as a leaf
    // by the download path's span-based leaf check.
    if (batch.length === 1) {
      intermediateChunks.push(batch[0])
      continue
    }

    // Calculate total span from all children
    const totalSpan = batch.reduce((sum, ref) => sum + ref.span, 0n)

    // Build intermediate chunk payload containing all 64-byte references
    // Pad to 4096 bytes with zeros BEFORE encryption
    const payload = new Uint8Array(4096)
    batch.forEach((ref, idx) => {
      payload.set(ref.address, idx * 64)
      payload.set(ref.key, idx * 64 + 32)
    })

    // Create chunk with correct span + payload
    const spanBytes = Span.fromBigInt(totalSpan).toUint8Array()
    const chunkData = Binary.concatBytes(spanBytes, payload)

    // Encrypt the chunk
    const encrypter = newChunkEncrypter()
    const { key, encryptedSpan, encryptedData } =
      encrypter.encryptChunk(chunkData)
    const encryptedChunkData = Binary.concatBytes(encryptedSpan, encryptedData)

    // Calculate address from encrypted chunk
    const address = await calculateChunkAddress(encryptedChunkData)

    await uploadIntermediate(encryptedChunkData)

    intermediateChunks.push({
      address: address.toUint8Array(),
      key,
      span: totalSpan,
    })
  }

  if (intermediateChunks.length > 1) {
    return buildEncryptedMerkleTree(intermediateChunks, uploadIntermediate)
  }

  const rootRef = new Uint8Array(64)
  rootRef.set(intermediateChunks[0].address, 0)
  rootRef.set(intermediateChunks[0].key, 32)
  return new Reference(rootRef)
}

// ============================================================================
// Public API: uploadData
// ============================================================================

/**
 * Upload data to Swarm.
 *
 * This is the unified entry point for all data uploads:
 * - Plain or encrypted (via encryptionKey option)
 * - Stamper-based or subsidised gateway (via target)
 * - HTTP or WebSocket transport (via webSocket option)
 *
 * @param target - Upload target (stamper or subsidised gateway)
 * @param data - Data to upload
 * @param options - Upload options
 * @returns Upload result with reference
 */
export async function uploadData(
  target: UploadTarget,
  data: Uint8Array,
  options?: UploadDataOptions,
): Promise<UploadDataResult> {
  const isEncrypted = options?.encryptionKey !== undefined

  if (isEncrypted) {
    return uploadDataEncrypted(target, data, options)
  } else {
    return uploadDataPlain(target, data, options)
  }
}

/**
 * Upload plain (unencrypted) data.
 */
async function uploadDataPlain(
  target: UploadTarget,
  data: Uint8Array,
  options?: UploadDataOptions,
): Promise<UploadDataResult> {
  const chunkPayloads = splitDataIntoChunks(data)

  // Create CAC for each payload
  const chunks: ContentAddressedChunk[] = []
  const chunkRefs: ChunkReference[] = []

  for (const payload of chunkPayloads) {
    const chunk = makeContentAddressedChunk(payload)
    chunks.push(chunk)
    chunkRefs.push({
      address: chunk.address.toUint8Array(),
      span: BigInt(payload.length),
    })
  }

  // Progress tracking
  let totalChunks = chunks.length
  let processedChunks = 0
  const reportProgress = () =>
    options?.onProgress?.({ total: totalChunks, processed: processedChunks })

  if (isSubsidisedTarget(target)) {
    // Subsidised gateway mode
    const uploadOptions = { pin: options?.pin, deferred: options?.deferred }

    for (const chunk of chunks) {
      await uploadChunkViaSubsidisedGatewayInternal(
        target.gatewayUrl,
        chunk.data,
        uploadOptions,
      )
      processedChunks++
      reportProgress()
    }

    // Build merkle tree if multiple chunks
    let rootReference: Reference

    if (chunkRefs.length === 1) {
      rootReference = new Reference(chunkRefs[0].address)
    } else {
      rootReference = await buildPlainMerkleTree(chunkRefs, async (chunk) => {
        await uploadChunkViaSubsidisedGatewayInternal(
          target.gatewayUrl,
          chunk.data,
          uploadOptions,
        )
        totalChunks++
        processedChunks++
        reportProgress()
      })
    }

    return { reference: rootReference.toHex() }
  } else {
    // Stamper mode
    const { bee, stamper, workerPool } = target
    const tag = options?.tag ?? (await tryCreateTag(bee))
    const uploadOptions = { ...options, tag, deferred: false }

    const stamp = makeStampFn(stamper, workerPool)

    // Upload leaf chunks
    for (const chunk of chunks) {
      await uploadStampedChunkViaHttp(
        bee,
        stamp,
        chunk.data,
        chunk.address.toUint8Array(),
        uploadOptions,
        options?.requestOptions,
      )
      processedChunks++
      reportProgress()
    }

    // Build merkle tree if multiple chunks
    let rootReference: Reference

    if (chunkRefs.length === 1) {
      rootReference = new Reference(chunkRefs[0].address)
    } else {
      rootReference = await buildPlainMerkleTree(chunkRefs, async (chunk) => {
        await uploadStampedChunkViaHttp(
          bee,
          stamp,
          chunk.data,
          chunk.address.toUint8Array(),
          uploadOptions,
          options?.requestOptions,
        )
        totalChunks++
        processedChunks++
        reportProgress()
      })
    }

    return { reference: rootReference.toHex(), tagUid: tag }
  }
}

/**
 * Upload encrypted data.
 */
async function uploadDataEncrypted(
  target: UploadTarget,
  data: Uint8Array,
  options?: UploadDataOptions,
): Promise<UploadDataResult> {
  // Determine encryption key
  const encryptionKey =
    options?.encryptionKey === true ? undefined : options?.encryptionKey

  // Split and encrypt
  const payloads = splitDataIntoChunks(data)
  const { chunks: encryptedChunks, refs: encryptedChunkRefs } =
    encryptChunkPayloads(payloads, encryptionKey)

  // Prepare chunk data for upload
  const chunksToUpload = encryptedChunks.map((chunk) => ({
    data: chunk.data,
    address: chunk.address.toUint8Array(),
  }))

  // Progress tracking
  let totalChunks = encryptedChunks.length
  let processedChunks = 0
  const uploadedChunkAddresses: Uint8Array[] = []

  const onChunkUploaded = (address: Uint8Array) => {
    uploadedChunkAddresses.push(address)
    processedChunks++
    options?.onProgress?.({ total: totalChunks, processed: processedChunks })
  }

  if (isSubsidisedTarget(target)) {
    // Subsidised gateway mode
    const uploadOptions = { pin: options?.pin, deferred: options?.deferred }

    for (const chunk of chunksToUpload) {
      await uploadChunkViaSubsidisedGatewayInternal(
        target.gatewayUrl,
        chunk.data,
        uploadOptions,
      )
      onChunkUploaded(chunk.address)
    }

    // Build merkle tree
    const rootReference = await buildEncryptedMerkleTree(
      encryptedChunkRefs,
      async (chunkData) => {
        await uploadChunkViaSubsidisedGatewayInternal(
          target.gatewayUrl,
          chunkData,
          uploadOptions,
        )
        const address = await calculateChunkAddress(chunkData)
        uploadedChunkAddresses.push(address.toUint8Array())
        totalChunks++
        processedChunks++
        options?.onProgress?.({
          total: totalChunks,
          processed: processedChunks,
        })
      },
    )

    return {
      reference: rootReference.toHex(),
      chunkAddresses: uploadedChunkAddresses,
    }
  } else {
    // Stamper mode
    const { bee, stamper, workerPool } = target
    const tag = options?.tag ?? (await tryCreateTag(bee))
    const uploadOptions = { ...options, tag, deferred: false }
    const stamp = makeStampFn(stamper, workerPool)

    // Open WebSocket stream if requested
    let wsStream: ChunkUploadStream | undefined
    if (options?.webSocket) {
      wsStream = new ChunkUploadStream(bee.url, {
        tag,
        concurrency: options.webSocket.concurrency,
      })
      await wsStream.open()
    }

    try {
      // Upload chunks
      if (wsStream) {
        await uploadChunksViaWebSocket(
          stamp,
          wsStream,
          chunksToUpload,
          onChunkUploaded,
        )
      } else {
        await uploadChunksViaHttp(
          bee,
          stamp,
          chunksToUpload,
          uploadOptions,
          options?.requestOptions,
          onChunkUploaded,
          options?.httpConcurrency,
        )
      }

      // Build merkle tree
      const rootReference = await buildEncryptedMerkleTree(
        encryptedChunkRefs,
        async (chunkData) => {
          const address = await calculateChunkAddress(chunkData)
          uploadedChunkAddresses.push(address.toUint8Array())

          if (wsStream) {
            await uploadStampedChunkViaWebSocket(
              stamp,
              wsStream,
              chunkData,
              address.toUint8Array(),
            )
          } else {
            await uploadStampedChunkViaHttp(
              bee,
              stamp,
              chunkData,
              address.toUint8Array(),
              uploadOptions,
              options?.requestOptions,
            )
          }

          totalChunks++
          processedChunks++
          options?.onProgress?.({
            total: totalChunks,
            processed: processedChunks,
          })
        },
      )

      return {
        reference: rootReference.toHex(),
        tagUid: tag,
        chunkAddresses: uploadedChunkAddresses,
      }
    } finally {
      if (wsStream) {
        await wsStream.close()
      }
    }
  }
}

// ============================================================================
// Public API: uploadSOC
// ============================================================================

/**
 * Upload a Single Owner Chunk (SOC).
 *
 * @param target - Upload target (stamper or subsidised gateway)
 * @param signer - Private key for signing the SOC
 * @param identifier - SOC identifier
 * @param data - Chunk payload (1-4096 bytes)
 * @param options - Upload options
 * @returns SOC address and optional encryption key
 */
export async function uploadSOC(
  target: UploadTarget,
  signer: PrivateKey,
  identifier: Identifier,
  data: Uint8Array,
  options?: UploadSOCOptions,
): Promise<UploadSOCResult> {
  // Validate data size
  if (data.length < 1 || data.length > 4096) {
    throw new Error(`Invalid data length: ${data.length} (expected 1-4096)`)
  }

  const isEncrypted = options?.encryptionKey !== undefined

  // Build chunk and determine what to sign/send
  let chunkAddress: Uint8Array
  let socBody: Uint8Array
  let encryptionKeyResult: Uint8Array | undefined

  if (isEncrypted) {
    // For encrypted SOC: use makeEncryptedContentAddressedChunk
    // This encrypts both span and payload, giving us the correct address for signing
    const encryptionKey =
      options.encryptionKey === true ? undefined : options.encryptionKey
    const encryptedChunk = makeEncryptedContentAddressedChunk(
      data,
      encryptionKey,
    )

    chunkAddress = encryptedChunk.address.toUint8Array()
    socBody = encryptedChunk.data
    encryptionKeyResult = encryptedChunk.encryptionKey
  } else {
    // For plain SOC: use unencrypted CAC
    const cac = makeContentAddressedChunk(data)
    chunkAddress = cac.address.toUint8Array()
    socBody = cac.data
  }

  const owner = signer.publicKey().address()

  // Sign: hash(identifier + chunkAddress)
  // For encrypted SOCs, this is the encrypted chunk address
  // For plain SOCs, this is the unencrypted chunk address
  const toSign = Binary.concatBytes(identifier.toUint8Array(), chunkAddress)
  const signature = signer.sign(toSign)

  // Calculate SOC address
  const socAddressBytes = Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )

  if (isSubsidisedTarget(target)) {
    // Subsidised gateway mode - no stamp needed
    const url = `${normalizeUrl(target.gatewayUrl)}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    }

    if (options?.deferred !== undefined) {
      headers["swarm-deferred-upload"] = options.deferred.toString()
    }
    if (options?.pin !== undefined) {
      headers["swarm-pin"] = options.pin.toString()
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: socBody,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new SocUploadError(
        response.status,
        `${response.statusText} (subsidised)`,
        errorText,
      )
    }

    return {
      socAddress: socAddressBytes,
      encryptionKey: encryptionKeyResult,
    }
  } else {
    // Stamper mode
    const { bee, stamper } = target
    const tag = options?.tag ?? (await tryCreateTag(bee))

    const envelope = stamper.stamp({
      hash: () => socAddressBytes,
      build: () => socBody,
      span: 0n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writer: undefined as any,
    })

    const stampHex = Binary.uint8ArrayToHex(marshalEnvelope(envelope))
    const url = `${bee.url}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "swarm-postage-stamp": stampHex,
    }
    if (tag) headers["swarm-tag"] = tag.toString()
    if (options?.deferred !== undefined) {
      headers["swarm-deferred-upload"] = options.deferred.toString()
    }
    if (options?.pin !== undefined) {
      headers["swarm-pin"] = options.pin.toString()
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: socBody,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new SocUploadError(response.status, response.statusText, errorText)
    }

    return {
      socAddress: socAddressBytes,
      encryptionKey: encryptionKeyResult,
      tagUid: tag,
    }
  }
}

// ============================================================================
// Public API: uploadChunk
// ============================================================================

/**
 * Upload a single pre-built chunk.
 *
 * @param target - Upload target (stamper or subsidised gateway)
 * @param chunkData - Full chunk data (span + payload)
 * @param options - Upload options
 * @returns Chunk reference
 */
export async function uploadChunk(
  target: UploadTarget,
  chunkData: Uint8Array,
  options?: UploadChunkOptions,
): Promise<UploadChunkResult> {
  if (isSubsidisedTarget(target)) {
    return uploadChunkViaSubsidisedGatewayInternal(
      target.gatewayUrl,
      chunkData,
      {
        pin: options?.pin,
        deferred: options?.deferred,
      },
    )
  } else {
    const { bee, stamper } = target
    const address = await calculateChunkAddress(chunkData)
    const stamp = makeStampFn(stamper)

    await uploadStampedChunkViaHttp(
      bee,
      stamp,
      chunkData,
      address.toUint8Array(),
      { deferred: false, pin: options?.pin, tag: options?.tag },
      options?.requestOptions,
    )

    return { reference: uint8ArrayToHex(address.toUint8Array()) }
  }
}

// ============================================================================
// Internal exports for legacy wrappers
// ============================================================================

// These are exposed for the legacy wrapper module to use
export {
  uploadChunkViaSubsidisedGatewayInternal,
  uploadStampedChunkViaHttp,
  makeStampFn,
  buildPlainMerkleTree,
  buildEncryptedMerkleTree,
  encryptChunkPayloads,
  type EncryptedChunkRef,
  type StampChunkFn,
}
