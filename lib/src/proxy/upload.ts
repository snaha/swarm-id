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
import {
  PrivateKey,
  Identifier,
  EthAddress,
  Signature,
} from "@ethersphere/bee-js"
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
  DEFAULT_UPLOAD_CONCURRENCY,
  SPAN_SIZE,
  IDENTIFIER_SIZE,
  SOC_HEADER_SIZE,
} from "../chunk"
import { CHUNK_SIZE, estimateTotalChunks, rechunk } from "./chunking"
import { ChunkUploadStream } from "./chunk-upload-stream"
import {
  ChunkSplitter,
  convertEnvelopeToMarshaledStamp,
  encryptData,
  encryptSpan,
  getMaxShards,
  makeEncryptedReplicas,
  makeErasureBatch,
  makeIntermediateChunkHandler,
  makeReplicas,
  makeSOCAddress,
  REPLICAS_OWNER,
} from "@ethersphere/core-sdk"
import type { ChunkBuilder } from "@ethersphere/core-sdk"
import type { RedundancyLevel } from "../types"
import type { UploadProgress } from "./types"
import type { StampWorkerPool } from "./stamp-worker-pool"
import { createTagIfSupported, tryCreateTag } from "../utils/tag"
import { uint8ArrayToHex, webBytes } from "../utils/hex"
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
  /**
   * Erasure-coding level, Bee's `swarm-redundancy-level` (#307): 0 none
   * (default), 1 medium, 2 strong, 3 insane, 4 paranoid. Each level adds
   * Reed-Solomon parity per batch of chunks and replicas of the root.
   */
  redundancyLevel?: RedundancyLevel
  /** Use deferred upload mode */
  deferred?: boolean
  /** Tag for tracking upload progress */
  tag?: number
  /**
   * Send the chunks over Bee's chunk stream instead of HTTP (stamper mode only;
   * a subsidised gateway stamps the chunks itself and takes no stream). The
   * stream carries a tag only when `deferred` is set; see
   * {@link refuseChunkStreamConflicts} for what it refuses.
   */
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
  /**
   * Addresses of all uploaded chunks: set by an encrypted {@link uploadData}
   * only. {@link uploadDataStream} never keeps them, so its memory does not
   * grow with the source.
   */
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

/** `requestOptions` with the request's abort `signal` on them, if there is one. */
function withSignal(
  requestOptions: BeeRequestOptions | undefined,
  signal: AbortSignal | undefined,
): BeeRequestOptions | undefined {
  return signal ? { ...requestOptions, signal } : requestOptions
}

/**
 * Create a StampChunkFn from a Stamper and optional worker pool.
 */
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
    body: webBytes(chunkData),
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

/**
 * The tag a caller gave, as Bee reads it: tag 0 is no tag (`Deferred: tag != 0`).
 */
function givenTag(tag: number | undefined): number | undefined {
  return tag === 0 ? undefined : tag
}

/**
 * Refuse what Bee's chunk stream cannot honour. Bee has no pinning on the
 * stream, and defers a stream's chunks exactly when the stream has a tag, so a
 * tag without `deferred` would make a direct upload deferred. Either is an
 * error rather than an upload that quietly differs from the request.
 */
export function refuseChunkStreamConflicts(
  options: Pick<UploadDataOptions, "pin" | "tag" | "deferred"> | undefined,
): void {
  if (options?.pin) {
    throw new SwarmIdError(
      "invalid-request",
      "Bee cannot pin chunks sent over WebSocket: upload without useWebSocket to pin",
    )
  }
  if (givenTag(options?.tag) !== undefined && !options?.deferred) {
    throw new SwarmIdError(
      "invalid-request",
      "A tag makes Bee defer the chunks it receives over WebSocket: pass deferred: true with it",
    )
  }
}

/**
 * The tag a stamper upload goes under: the caller's, or one made for it. Over
 * WebSocket the tag is what defers the stream, so a direct stream gets none,
 * and a deferred one on a node without tags is refused rather than sent
 * direct. A deferred one whose tag the node fails to make rejects with Bee's
 * own error. Also refuses what the stream cannot honour, before anything is
 * made.
 */
export async function stamperUploadTag(
  bee: Bee,
  options:
    | Pick<UploadDataOptions, "pin" | "tag" | "deferred" | "webSocket">
    | undefined,
): Promise<number | undefined> {
  const given = givenTag(options?.tag)
  if (!options?.webSocket) return given ?? (await tryCreateTag(bee))
  refuseChunkStreamConflicts(options)
  if (!options.deferred) return undefined
  const tag = given ?? (await createTagIfSupported(bee))
  if (tag === undefined) {
    throw new SwarmIdError(
      "invalid-request",
      "Bee defers chunks sent over WebSocket only under a tag, and the node does not support tags: pass a tag, or upload without useWebSocket",
    )
  }
  return tag
}

/** Where the chunks of one upload go, and how many may be on the way at once. */
interface ChunkSender {
  concurrency: number
  tagUid?: number
  send: (chunkData: Uint8Array, address: Uint8Array) => Promise<void>
  /** End an upload whose chunks all landed. */
  close: () => Promise<void>
  /**
   * End a failed upload at once: the sends still out are stopped, not waited
   * for (the WebSocket's acks still due, the HTTP requests still open), so the
   * caller sees the chunk's error, not the transport's closing.
   */
  abandon: () => void
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
      // One send at a time: when it fails, no other is out to stop.
      abandon: () => {},
    }
  }

  const { bee, stamper, workerPool, counter, signal } = target
  // Built before the stream opens, so nothing can throw between opening the
  // stream and the caller holding a sender that ends it.
  const stamp = makeStampFn(stamper, workerPool, counter, signal)
  const tag = await stamperUploadTag(bee, options)

  if (options?.webSocket) {
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
      abandon: () => stream.abandon(),
    }
  }

  const uploadOptions: UploadOptions = {
    pin: options?.pin,
    tag,
    deferred: options?.deferred ?? false,
  }
  // Aborts the requests still out once one has failed: bee-js sets no timeout
  // of its own, so one that never answers would hold the upload's failure.
  const abandoned = new AbortController()
  const requestOptions = withSignal(
    options?.requestOptions,
    signal ? AbortSignal.any([signal, abandoned.signal]) : abandoned.signal,
  )
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
    abandon: () => abandoned.abort(),
  }
}

/**
 * The chunks of one upload on their way to the node. `submit` waits for a free
 * slot, which is the whole of the upload's backpressure: nothing further is
 * read from the source until the node has taken something.
 *
 * Every wait here attaches only to promises that settle while the upload
 * runs. One reaction per block on a promise that outlives them all would keep
 * every block reachable until the upload ended.
 */
export class SendWindow {
  private readonly inFlight = new Set<Promise<void>>()
  private failure: { error: unknown } | undefined
  /** The waits {@link orFailure} has open, each ended by the first failure. */
  private readonly failureWaiters = new Set<(error: unknown) => void>()

  constructor(
    private readonly limit: number,
    private readonly send: ChunkSender["send"],
    private readonly onSent: (address: Uint8Array) => void,
  ) {}

  async submit(chunkData: Uint8Array, address: Uint8Array): Promise<void> {
    // A failed send settles its `sending` too, so this wait sees failures.
    while (this.inFlight.size >= this.limit && !this.failure) {
      await Promise.race(this.inFlight)
    }
    this.throwIfFailed()
    // A throwing `onSent` fails the upload as a failed send does, and `sending`
    // itself never rejects: nothing is bound to observe it.
    const sending: Promise<void> = this.send(chunkData, address)
      .then(() => this.onSent(address))
      .catch((error: unknown) => this.fail(error))
      .finally(() => this.inFlight.delete(sending))
    this.inFlight.add(sending)
  }

  /** `work`, unless a send fails first: then that failure. */
  async orFailure<T>(work: Promise<T>): Promise<T> {
    this.throwIfFailed()
    let stop: (error: unknown) => void = () => {}
    const failed = new Promise<never>((_resolve, reject) => {
      stop = reject
    })
    this.failureWaiters.add(stop)
    try {
      return await Promise.race([work, failed])
    } finally {
      this.failureWaiters.delete(stop)
    }
  }

  /** Wait for everything submitted to land, or for the first failure. */
  async drain(): Promise<void> {
    await this.orFailure(Promise.all(this.inFlight))
    this.throwIfFailed()
  }

  /** Wait for the sends still running, however they end. */
  async settled(): Promise<void> {
    await Promise.all(this.inFlight)
  }

  private fail(error: unknown): void {
    this.failure ??= { error }
    for (const stop of this.failureWaiters) stop(this.failure.error)
    this.failureWaiters.clear()
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure.error
  }
}

// ============================================================================
// Merkle Tree Building
// ============================================================================

const ENCRYPTION_KEY_SIZE = 32

/**
 * A sealed chunk of core-sdk's splitter as it goes on the wire: encrypted
 * with its key when it has one, otherwise trimmed to what was written into
 * it, as Bee stores a chunk. Parity is the exception and goes out whole:
 * core-sdk builds a parity chunk from its bytes without writing them, so its
 * writer cursor stays 0, and every chunk the splitter hands on with nothing
 * written is one. (The empty file's single chunk has nothing written either,
 * but it is the root, which never reaches `makeErasureBatch`.)
 *
 * ponytail: the splitter already hashed (and, for an encrypted tree,
 * encrypted) every chunk to reference it, but core-sdk 0.2's `ChunkEntry`
 * hands on neither the address nor the encrypted bytes, so each chunk is
 * hashed and encrypted a second time here. core-sdk 0.3 puts the address on
 * the entry (core-sdk#23); take it once bee-js depends on 0.3, so both share
 * one copy of core-sdk's classes.
 */
function wireChunk(
  chunk: ChunkBuilder,
  key?: Uint8Array,
  isRoot = false,
): { chunkData: Uint8Array; address: Uint8Array } {
  const built = chunk.build()
  const isParity = chunk.writer.cursor === 0 && !isRoot
  const chunkData = key
    ? Binary.concatBytes(
        encryptSpan(key, built.subarray(0, SPAN_SIZE)),
        encryptData(key, chunk.writer.buffer),
      )
    : isParity
      ? built
      : built.subarray(0, SPAN_SIZE + chunk.writer.cursor)
  return {
    chunkData,
    address: calculateChunkAddress(chunkData).toUint8Array(),
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

  const { chunkAddresses } = known
  const level = options?.redundancyLevel ?? 0
  const encrypted = options?.encryptionKey !== undefined
  // Only the root can take a caller's key: `uploadData` refuses one for more
  // than a chunk, so the root is then the only chunk.
  const rootKey =
    options?.encryptionKey instanceof Uint8Array
      ? options.encryptionKey
      : undefined

  const estimated =
    known.size !== undefined
      ? estimateTotalChunks(known.size, encrypted, level)
      : 0
  let submitted = 0
  let processed = 0
  const reportProgress = (total = Math.max(estimated, submitted)) =>
    options?.onProgress?.({ total, processed })

  const sender = await openChunkSender(target, encrypted, options)
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
  const submit = ({ chunkData, address }: ReturnType<typeof wireChunk>) =>
    sends.submit(chunkData, address)

  // ponytail: one pipeline for every level, 0 included, built by core-sdk's
  // splitter. Its ceiling: the splitter holds a whole batch of sealed chunks
  // (up to 128) before handing any on, and seals a leaf only once the next
  // one starts, where a leaf used to go out as soon as it was cut. Streaming
  // memory grows by that batch, and a stalled source sends nothing until a
  // batch fills. Parity needs the batch; level 0 does not, so the fix
  // belongs upstream in core-sdk: hand level-0 chunks on as they seal.
  const tree = new ChunkSplitter(
    makeErasureBatch(level, encrypted, (chunk, key) =>
      submit(wireChunk(chunk, key)),
    ),
    getMaxShards(level, encrypted),
    encrypted,
    makeIntermediateChunkHandler(level),
  )

  const payloads = rechunk(source, CHUNK_SIZE)
  let closed = false
  try {
    while (true) {
      // A send can fail while the source has nothing to give.
      const next = await sends.orFailure(payloads.next())
      if (next.done) break
      await sends.orFailure(tree.append(next.value))
    }
    // Zero-length content leaves the root an empty chunk (span 0): Bee's
    // canonical representation of an empty file.
    const root = await sends.orFailure(tree.finalize())
    const key = encrypted
      ? (rootKey ?? crypto.getRandomValues(new Uint8Array(ENCRYPTION_KEY_SIZE)))
      : undefined
    const rootChunk = wireChunk(root, key, true)
    await submit(rootChunk)
    await sends.drain()
    await sender.close()
    closed = true
    // Bee's dispersed replicas of the root, so a reader finds it with the
    // root's own neighbourhood gone. Tag 0 is no tag: a direct stream has none.
    const replicas = key
      ? makeEncryptedReplicas(root, key, level)
      : makeReplicas(root, level)
    await uploadReplicas(
      target,
      replicas,
      {
        tag: sender.tagUid ?? 0,
        deferred: options?.deferred ?? false,
        pin: options?.pin,
        requestOptions: options?.requestOptions,
      },
      (address) => {
        chunkAddresses?.push(address)
        processed++
        reportProgress()
      },
    )
    if (estimated !== processed) reportProgress(processed)

    return {
      reference: uint8ArrayToHex(
        key ? Binary.concatBytes(rootChunk.address, key) : rootChunk.address,
      ),
      tagUid: sender.tagUid,
      chunkAddresses,
    }
  } finally {
    // Not awaited: it queues behind a `next()` the source may never answer.
    void payloads.return(undefined).catch(() => {})
    // Abandoned first: it stops the sends still out, which settles them.
    if (!closed) sender.abandon()
    await sends.settled()
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
  const tagUid = await postSOC(
    target,
    { owner, identifier, signature, socAddress: socAddressBytes, socBody },
    options,
  )
  return {
    socAddress: socAddressBytes,
    encryptionKey: encryptionKeyResult,
    tagUid,
  }
}

/** A signed single-owner chunk, split the way Bee's `/soc` endpoint takes it. */
interface SignedSOC {
  owner: EthAddress
  identifier: Identifier
  signature: Signature
  socAddress: Uint8Array
  /** Span and payload of the wrapped content-addressed chunk */
  socBody: Uint8Array
}

/**
 * POST a signed SOC to `/soc`, stamped in stamper mode. Resolves with the
 * tag it went under: `options.tag`, or one created for it in stamper mode.
 */
async function postSOC(
  target: UploadTarget,
  soc: SignedSOC,
  options?: Pick<
    UploadSOCOptions,
    "tag" | "deferred" | "pin" | "requestOptions"
  >,
): Promise<number | undefined> {
  const { owner, identifier, signature, socAddress, socBody } = soc
  const path = `/soc/${owner.toHex()}/${identifier.toHex()}?sig=${signature.toHex()}`

  if (isSubsidisedTarget(target)) {
    // Subsidised gateway mode - no stamp needed
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    }
    if (options?.deferred !== undefined) {
      headers["swarm-deferred-upload"] = options.deferred.toString()
    }

    const response = await fetch(`${normalizeUrl(target.gatewayUrl)}${path}`, {
      method: "POST",
      headers,
      body: webBytes(socBody),
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
    return undefined
  }

  // Stamper mode
  const { bee, stamper } = target
  const tag = options?.tag ?? (await tryCreateTag(bee))

  const { signal } = withSignal(options?.requestOptions, target.signal) ?? {}
  if (signal?.aborted) throw abortedError(signal)
  const envelope = stamper.stamp(socAddress)
  if (target.counter) target.counter.chunks++

  const headers: Record<string, string> = {
    ...beeHeaders(bee, options?.requestOptions),
    "content-type": "application/octet-stream",
    "swarm-postage-stamp": convertEnvelopeToMarshaledStamp(envelope).toHex(),
  }
  if (tag) headers["swarm-tag"] = tag.toString()
  if (options?.deferred !== undefined) {
    headers["swarm-deferred-upload"] = options.deferred.toString()
  }
  if (options?.pin !== undefined) {
    headers["swarm-pin"] = options.pin.toString()
  }

  const response = await fetch(`${bee.url}${path}`, {
    method: "POST",
    headers,
    body: webBytes(socBody),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new SocUploadError(response.status, response.statusText, errorText)
  }
  return tag
}

/**
 * Upload the root replicas of an erasure-coded tree (#307): single-owner
 * chunks under Bee's well-known replica owner, which go through `/soc` like
 * any SOC. bee-js's chunk upload refuses them as oversized, and the chunk
 * stream is not where Bee takes SOCs.
 */
async function uploadReplicas(
  target: UploadTarget,
  replicas: { address: { toUint8Array(): Uint8Array }; data: Uint8Array }[],
  options: Pick<
    UploadSOCOptions,
    "tag" | "deferred" | "pin" | "requestOptions"
  >,
  onSent: (address: Uint8Array) => void,
): Promise<void> {
  const owner = new EthAddress(REPLICAS_OWNER)
  for (const { address, data } of replicas) {
    await postSOC(
      target,
      {
        owner,
        identifier: new Identifier(data.subarray(0, IDENTIFIER_SIZE)),
        signature: new Signature(
          data.subarray(IDENTIFIER_SIZE, SOC_HEADER_SIZE),
        ),
        socAddress: address.toUint8Array(),
        socBody: data.subarray(SOC_HEADER_SIZE),
      },
      options,
    )
    onSent(address.toUint8Array())
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
