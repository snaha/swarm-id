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

import { SwarmIdError, abortedError } from "../errors"
import { refusedPath } from "./errors"
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
  DEFAULT_UPLOAD_CONCURRENCY,
  ENCRYPTED_REF_SIZE,
  UNENCRYPTED_REF_SIZE,
} from "../chunk"
import {
  CHUNK_SIZE,
  ENCRYPTED_REFS_PER_CHUNK,
  PLAIN_REFS_PER_CHUNK,
  estimateTotalChunks,
  rechunk,
} from "./chunking"
import { ChunkUploadStream } from "./chunk-upload-stream"
import {
  convertEnvelopeToMarshaledStamp,
  makeSOCAddress,
} from "@ethersphere/core-sdk"
import type { UploadProgress } from "./types"
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
  /** What the node or gateway answered, for the bridge's `beeMessage` (#761) */
  readonly body: string

  constructor(status: number, statusText: string, body: string) {
    super(`SOC upload failed: ${status} ${statusText} - ${body}`)
    this.name = "SocUploadError"
    this.status = status
    this.body = body
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * The chunks one write has sent so far (#932): one per stamp in stamper mode,
 * one per chunk the gateway accepted in subsidised mode. The proxy puts a
 * fresh one on the target of each request and reports it with the result.
 */
export interface ChunkCounter {
  chunks: number
}

/**
 * Upload target: stamper-based (user has postage batch) or subsidised gateway.
 * `signal` is the request's abort: the proxy puts it here beside the
 * counter, so every write through the target stops with it.
 */
export type UploadTarget =
  | {
      mode: "stamper"
      bee: Bee
      stamper: Stamper
      workerPool?: StampWorkerPool
      counter?: ChunkCounter
      signal?: AbortSignal
    }
  | {
      mode: "subsidised"
      gatewayUrl: string
      counter?: ChunkCounter
      signal?: AbortSignal
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
  /** Pin the uploaded data (stamper mode only; a subsidised gateway never sees it, #752) */
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
 * Options for {@link uploadDataStream}. Encryption is per-chunk with generated
 * keys only: a caller's key can only apply to data known to fit one chunk.
 */
export interface UploadDataStreamOptions extends Omit<
  UploadDataOptions,
  "encryptionKey"
> {
  encryptionKey?: true
  /** The source's length in bytes, if known, for progress to have a total */
  size?: number
}

/**
 * Options for SOC upload
 */
export interface UploadSOCOptions {
  /** Encryption key: undefined = plain SOC, Uint8Array = use this key, true = auto-generate */
  encryptionKey?: Uint8Array | true
  /** Pin the uploaded SOC (stamper mode only; a subsidised gateway never sees it, #752) */
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
  /** Pin the uploaded chunk (stamper mode only; a subsidised gateway never sees it, #752) */
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
 * Async stamp function - abstraction over sync Stamper and parallel StampWorkerPool.
 */
type StampChunkFn = (address: Uint8Array) => Promise<EnvelopeWithBatchId>

/**
 * Create a StampChunkFn from a Stamper and optional worker pool.
 */
function withSignal(
  requestOptions: BeeRequestOptions | undefined,
  signal: AbortSignal | undefined,
): BeeRequestOptions | undefined {
  return signal ? { ...requestOptions, signal } : requestOptions
}

function makeStampFn(
  stamper: Stamper,
  workerPool?: StampWorkerPool,
  counter?: ChunkCounter,
  signal?: AbortSignal,
): StampChunkFn {
  const stamp: StampChunkFn = workerPool
    ? (address) => workerPool.stampChunkData(address)
    : (address) => Promise.resolve(stamper.stamp(address))
  return async (address) => {
    if (signal?.aborted) throw abortedError(signal)
    const envelope = await stamp(address)
    if (counter) counter.chunks++
    return envelope
  }
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
  const envelope = await stamp(address)
  await bee.chunk.upload(envelope, chunkData, options, requestOptions)
}

/**
 * The headers `bee.chunk.upload` would send: the `Bee` instance's own, then
 * the call's `requestOptions` on top — for the one hand-rolled `fetch` sent
 * to a `Bee` instance rather than through a bee-js call (#819). bee-js keeps the
 * instance options private, so this reads the field it stores them in.
 */
function beeHeaders(
  bee: Bee,
  requestOptions?: BeeRequestOptions,
): Record<string, string> {
  const instance = (bee as unknown as { requestOptions?: BeeRequestOptions })
    .requestOptions
  return { ...instance?.headers, ...requestOptions?.headers }
}

/**
 * Upload a chunk via subsidised gateway (no stamp required).
 */
async function uploadChunkViaSubsidisedGatewayInternal(
  gatewayUrl: string,
  chunkData: Uint8Array,
  options?: { deferred?: boolean; signal?: AbortSignal },
  counter?: ChunkCounter,
): Promise<{ reference: string }> {
  const url = `${normalizeUrl(gatewayUrl)}/chunks`

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }

  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: chunkData,
    signal: options?.signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new SwarmIdError(
      "bee-rejected",
      `Subsidised chunk upload failed: ${response.status} ${response.statusText} - ${errorText}`,
      {
        status: response.status,
        beeMessage: errorText,
        url: refusedPath(response.url),
      },
    )
  }

  const result = await response.json()
  if (counter) counter.chunks++
  return { reference: result.reference }
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
  const envelope = await stamp(address)
  const stamped = Binary.concatBytes(
    convertEnvelopeToMarshaledStamp(envelope).toUint8Array(),
    chunkData,
  )
  await stream.uploadChunk(stamped)
}

// ============================================================================
// Chunk Sending
// ============================================================================

/** Where the chunks of one upload go, and how many may be on the way at once. */
interface ChunkSender {
  concurrency: number
  tagUid?: number
  send: (chunkData: Uint8Array, address: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

async function openChunkSender(
  target: UploadTarget,
  isEncrypted: boolean,
  options?: UploadDataOptions | UploadDataStreamOptions,
): Promise<ChunkSender> {
  if (isSubsidisedTarget(target)) {
    const uploadOptions = {
      deferred: options?.deferred,
      signal: target.signal,
    }
    return {
      concurrency: 1,
      send: async (chunkData) => {
        await uploadChunkViaSubsidisedGatewayInternal(
          target.gatewayUrl,
          chunkData,
          uploadOptions,
          target.counter,
        )
      },
      close: async () => {},
    }
  }

  const { bee, stamper, workerPool, counter, signal } = target
  const tag = options?.tag ?? (await tryCreateTag(bee))
  const stamp = makeStampFn(stamper, workerPool, counter, signal)

  if (isEncrypted && options?.webSocket) {
    const stream = new ChunkUploadStream(bee.url, {
      tag,
      concurrency: options.webSocket.concurrency,
      signal,
    })
    await stream.open()
    return {
      concurrency: stream.getConcurrency(),
      tagUid: tag,
      send: (chunkData, address) =>
        uploadStampedChunkViaWebSocket(stamp, stream, chunkData, address),
      close: () => stream.close(),
    }
  }

  const uploadOptions: UploadOptions = {
    pin: options?.pin,
    tag,
    deferred: options?.deferred ?? false,
  }
  const requestOptions = withSignal(options?.requestOptions, signal)
  return {
    concurrency:
      options?.httpConcurrency ??
      (isEncrypted ? DEFAULT_UPLOAD_CONCURRENCY : 1),
    tagUid: tag,
    send: (chunkData, address) =>
      uploadStampedChunkViaHttp(
        bee,
        stamp,
        chunkData,
        address,
        uploadOptions,
        requestOptions,
      ),
    close: async () => {},
  }
}

/**
 * The chunks of one upload on their way to the node. `submit` waits for a free
 * slot, which is the whole of the upload's backpressure: nothing further is
 * read from the source until the node has taken something.
 */
class SendWindow {
  private readonly inFlight = new Set<Promise<void>>()
  private failure: { error: unknown } | undefined
  private reject!: (error: unknown) => void
  /** Rejects with the first failed send; never resolves. */
  readonly failed = new Promise<never>((_resolve, reject) => {
    this.reject = reject
  })

  constructor(
    private readonly limit: number,
    private readonly send: ChunkSender["send"],
    private readonly onSent: (address: Uint8Array) => void,
  ) {
    // Observed only by a race, and there may be none left to observe it.
    this.failed.catch(() => {})
  }

  async submit(chunkData: Uint8Array, address: Uint8Array): Promise<void> {
    while (this.inFlight.size >= this.limit && !this.failure) {
      await Promise.race([...this.inFlight, this.failed])
    }
    if (this.failure) throw this.failure.error
    const sending: Promise<void> = this.send(chunkData, address)
      .then(
        () => this.onSent(address),
        (error: unknown) => {
          this.failure ??= { error }
          this.reject(error)
        },
      )
      .finally(() => this.inFlight.delete(sending))
    this.inFlight.add(sending)
  }

  /** Wait for everything submitted to land, or for the first failure. */
  async drain(): Promise<void> {
    await Promise.race([Promise.all(this.inFlight), this.failed])
  }

  /** Wait for the sends still running, however they end. */
  async settled(): Promise<void> {
    await Promise.all(this.inFlight)
  }
}

/**
 * Send the intermediate chunk over `refs` and resolve with its reference. A
 * reference is known from the bytes alone, so chunks may land in any order and
 * the tree never waits for an answer from the node.
 */
type WrapChunk = (refs: TreeRef[]) => Promise<TreeRef>

// ============================================================================
// Merkle Tree Building
// ============================================================================

/** One child of an intermediate chunk. `key` is set on encrypted trees. */
interface TreeRef {
  address: Uint8Array
  key?: Uint8Array
  span: bigint
}

/**
 * Builds a Merkle tree from its leaves as they arrive, holding one partial
 * intermediate per level rather than every reference: a full level is wrapped
 * at once and only the wrapper is carried up.
 */
class ReferenceTree {
  private readonly levels: TreeRef[][] = [[]]

  constructor(
    private readonly fanout: number,
    private readonly wrap: WrapChunk,
  ) {}

  async add(ref: TreeRef, level = 0): Promise<void> {
    const refs = (this.levels[level] ??= [])
    refs.push(ref)
    if (refs.length < this.fanout) return
    this.levels[level] = []
    await this.add(await this.wrap(refs), level + 1)
  }

  async finish(): Promise<TreeRef> {
    for (let level = 0; ; level++) {
      const refs = this.levels[level]
      const nothingAbove = this.levels
        .slice(level + 1)
        .every((above) => above.length === 0)
      if (nothingAbove && refs.length === 1) return refs[0]
      if (refs.length === 0) continue
      this.levels[level] = []
      // Bee's "carrier chunk" rule: a lone reference moves up unwrapped. A
      // ghost intermediate with span ≤ 4096 would read back as a leaf.
      const carried = refs.length === 1 ? refs[0] : await this.wrap(refs)
      ;(this.levels[level + 1] ??= []).push(carried)
    }
  }
}

function plainWrap(sends: SendWindow): WrapChunk {
  return async (refs) => {
    const payload = new Uint8Array(refs.length * UNENCRYPTED_REF_SIZE)
    refs.forEach((ref, index) => {
      payload.set(ref.address, index * UNENCRYPTED_REF_SIZE)
    })
    // An intermediate chunk's span is the data length its children cover, not
    // the length of its references: the downloader tells it from a leaf by it.
    const span = refs.reduce((sum, ref) => sum + ref.span, 0n)
    const chunk = makeContentAddressedChunk(payload, span)
    const address = chunk.address.toUint8Array()
    await sends.submit(chunk.data, address)
    return { address, span }
  }
}

function encryptedWrap(sends: SendWindow): WrapChunk {
  return async (refs) => {
    // Padded with zeros to a full chunk before encryption
    const payload = new Uint8Array(CHUNK_SIZE)
    refs.forEach((ref, index) => {
      payload.set(ref.address, index * ENCRYPTED_REF_SIZE)
      payload.set(ref.key!, index * ENCRYPTED_REF_SIZE + UNENCRYPTED_REF_SIZE)
    })
    const span = refs.reduce((sum, ref) => sum + ref.span, 0n)
    const { key, encryptedSpan, encryptedData } =
      newChunkEncrypter().encryptChunk(
        Binary.concatBytes(Span.fromBigInt(span).toUint8Array(), payload),
      )
    const chunkData = Binary.concatBytes(encryptedSpan, encryptedData)
    const address = calculateChunkAddress(chunkData).toUint8Array()
    await sends.submit(chunkData, address)
    return { address, key, span }
  }
}

// ============================================================================
// Public API: uploadData
// ============================================================================

async function* onePiece(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data
}

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
  const { encryptionKey } = options ?? {}
  if (encryptionKey instanceof Uint8Array && data.length > CHUNK_SIZE) {
    throw new Error(
      `Explicit encryption key is only supported for single-chunk data (up to ${CHUNK_SIZE} bytes), got ${Math.ceil(data.length / CHUNK_SIZE)} chunks — pass encryptionKey: true to auto-generate per-chunk keys`,
    )
  }
  return writeTree(target, onePiece(data), options, {
    size: data.length,
    chunkAddresses: encryptionKey !== undefined ? [] : undefined,
  })
}

/**
 * {@link uploadData} for bytes that arrive over time. Only what is on its way
 * to the node is held, so `source` may be far larger than memory: it is read
 * no faster than the node takes chunks. The reference depends on the bytes
 * alone, not on how `source` cuts them up.
 */
export async function uploadDataStream(
  target: UploadTarget,
  source: AsyncIterable<Uint8Array>,
  options?: UploadDataStreamOptions,
): Promise<UploadDataResult> {
  return writeTree(target, source, options, { size: options?.size })
}

async function writeTree(
  target: UploadTarget,
  source: AsyncIterable<Uint8Array>,
  options: UploadDataOptions | UploadDataStreamOptions | undefined,
  known: { size?: number; chunkAddresses?: Uint8Array[] },
): Promise<UploadDataResult> {
  const { signal } = target
  if (signal?.aborted) throw abortedError(signal)

  const isEncrypted = options?.encryptionKey !== undefined
  const explicitKey =
    options?.encryptionKey instanceof Uint8Array
      ? options.encryptionKey
      : undefined
  const fanout = isEncrypted ? ENCRYPTED_REFS_PER_CHUNK : PLAIN_REFS_PER_CHUNK
  const { chunkAddresses } = known

  const estimated =
    known.size !== undefined ? estimateTotalChunks(known.size, fanout) : 0
  let submitted = 0
  let processed = 0
  const reportProgress = (total = Math.max(estimated, submitted)) =>
    options?.onProgress?.({ total, processed })

  const sender = await openChunkSender(target, isEncrypted, options)
  const sends = new SendWindow(
    sender.concurrency,
    (chunkData, address) => {
      submitted++
      return sender.send(chunkData, address)
    },
    (address) => {
      chunkAddresses?.push(address)
      processed++
      reportProgress()
    },
  )
  const tree = new ReferenceTree(
    fanout,
    isEncrypted ? encryptedWrap(sends) : plainWrap(sends),
  )

  const sendLeaf = async (payload: Uint8Array): Promise<void> => {
    if (isEncrypted) {
      const chunk = makeEncryptedContentAddressedChunk(payload, explicitKey)
      const address = chunk.address.toUint8Array()
      await sends.submit(chunk.data, address)
      return tree.add({
        address,
        key: chunk.encryptionKey,
        span: BigInt(payload.length),
      })
    }
    const chunk = makeContentAddressedChunk(payload)
    const address = chunk.address.toUint8Array()
    await sends.submit(chunk.data, address)
    return tree.add({ address, span: BigInt(payload.length) })
  }

  const payloads = rechunk(source, CHUNK_SIZE)
  try {
    let hasContent = false
    while (true) {
      // A send can fail while the source has nothing to give.
      const next = await Promise.race([payloads.next(), sends.failed])
      if (next.done) break
      hasContent = true
      await sendLeaf(next.value)
    }
    // Zero-length content is a single empty chunk (span 0): Bee's canonical
    // representation of an empty file.
    if (!hasContent) await sendLeaf(new Uint8Array(0))

    const root = await tree.finish()
    await sends.drain()
    if (estimated !== processed) reportProgress(processed)

    const rootBytes = root.key
      ? Binary.concatBytes(root.address, root.key)
      : root.address
    return {
      reference: new Reference(rootBytes).toHex(),
      tagUid: sender.tagUid,
      chunkAddresses,
    }
  } finally {
    // Not awaited: it queues behind a `next()` the source may never answer.
    void payloads.return(undefined).catch(() => {})
    await sends.settled()
    await sender.close()
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
    throw new SwarmIdError(
      "invalid-request",
      `Invalid data length: ${data.length} (expected 1-4096)`,
    )
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

  const socAddressBytes = makeSOCAddress(identifier, owner).toUint8Array()

  if (isSubsidisedTarget(target)) {
    // Subsidised gateway mode - no stamp needed
    const url = `${normalizeUrl(target.gatewayUrl)}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    }

    if (options?.deferred !== undefined) {
      headers["swarm-deferred-upload"] = options.deferred.toString()
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: socBody,
      signal: target.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new SocUploadError(
        response.status,
        `${response.statusText} (subsidised)`,
        errorText,
      )
    }
    if (target.counter) target.counter.chunks++

    return {
      socAddress: socAddressBytes,
      encryptionKey: encryptionKeyResult,
    }
  } else {
    // Stamper mode
    const { bee, stamper } = target
    const tag = options?.tag ?? (await tryCreateTag(bee))

    const { signal } = withSignal(options?.requestOptions, target.signal) ?? {}
    if (signal?.aborted) throw abortedError(signal)
    const envelope = stamper.stamp(socAddressBytes)
    if (target.counter) target.counter.chunks++

    const stampHex = convertEnvelopeToMarshaledStamp(envelope).toHex()
    const url = `${bee.url}/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

    const headers: Record<string, string> = {
      ...beeHeaders(bee, options?.requestOptions),
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
      signal,
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
      { deferred: options?.deferred, signal: target.signal },
      target.counter,
    )
  } else {
    const { bee, stamper } = target
    const address = await calculateChunkAddress(chunkData)
    const stamp = makeStampFn(stamper, undefined, target.counter, target.signal)
    const requestOptions = withSignal(options?.requestOptions, target.signal)

    await uploadStampedChunkViaHttp(
      bee,
      stamp,
      chunkData,
      address.toUint8Array(),
      {
        deferred: options?.deferred ?? false,
        pin: options?.pin,
        tag: options?.tag,
      },
      requestOptions,
    )

    return { reference: uint8ArrayToHex(address.toUint8Array()) }
  }
}
