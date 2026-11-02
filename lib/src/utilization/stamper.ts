// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stamper that owns slot assignment for a postage batch: which slot of
 * its bucket each chunk is stamped at, behind the partition lease fence.
 */

import {
  type Stamper,
  BatchId,
  EthAddress,
  PrivateKey,
  type EnvelopeWithBatchId,
} from "@ethersphere/bee-js"
import { stamp as stampAtSlot } from "@ethersphere/core-sdk"
import { Binary } from "cafe-utility"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import { lockSocAddress } from "../utils/lock-soc"
import { deriveSecret, BACKUP_KEY_LABEL } from "../utils/key-derivation"
import { uint8ArrayToHex } from "../utils/hex"
import { LEASE_SKEW_MARGIN_MS } from "../sync/timing-constants"
import {
  NUM_BUCKETS,
  PARTITION_COUNT,
  calculateMaxSlotsPerBucket,
  counterLayoutDepth,
  dataSlot,
  extractChunk,
  getChunkIndexForBucket,
  getChunkLayout,
  mergeChunk,
  partitionCapacity,
  toBucket,
} from "./layout"
import {
  chooseUtilizationChunkKey,
  claimedBucketsForCleanChunks,
} from "./chunk"
import {
  initializeBatchUtilization,
  type BatchUtilizationState,
  type UtilizationChunkReserver,
} from "./state"

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown by `UtilizationAwareStamper.stamp()` when the partition lease was
 * invalidated (peer took over the partition) between binding and stamping.
 * Callers should surface this as "your partition was reclaimed" — the
 * upload cannot complete and any in-flight chunks would silently overwrite
 * the peer's data if stamped anyway.
 */
export class PartitionLeaseLostError extends Error {
  constructor(message = "Partition lease was reclaimed by another device.") {
    super(message)
    this.name = "PartitionLeaseLostError"
  }
}

// ============================================================================
// Utilization-Aware Stamper (Wrapper with Auto-Tracking)
// ============================================================================

/**
 * Decides which slot of its bucket a chunk is stamped at. Assigning a slot
 * spends it, so a stamp has exactly one assigner however many things can sign.
 */
export interface SlotAssigner {
  readonly batchId: BatchId
  assignSlot(chunkAddress: Uint8Array): number
}

/**
 * Stamper that owns slot assignment for a postage batch
 *
 * - Loads the per-bucket counters from cached utilization data on creation
 * - `assignSlot()` decides where a chunk's stamp goes: a reserved slot for the
 *   lock / intent SOCs and utilisation chunks, otherwise the next slot of this
 *   device's partition lane, behind the lease fence
 * - `stamp()` is `assignSlot()` plus core-sdk's stateless signing. Anything
 *   that signs elsewhere (`StampWorkerPool`) takes its slot from `assignSlot()`
 *   too, so there is one slot owner whoever signs
 * - Provides a flush() method to persist updates back to cache
 */
export class UtilizationAwareStamper
  implements Stamper, SlotAssigner, UtilizationChunkReserver
{
  private utilizationState: BatchUtilizationState
  private cache: UtilizationStoreDB
  private readonly encryptionKey: Uint8Array
  private dirty: boolean = false
  private dirtyBuckets: Set<number> = new Set()

  /**
   * Partition this device holds within the shared postage batch. `undefined`
   * means the legacy single-device path, stamped as partition 0 of 1: the
   * behaviour for every account created before the partition-lease shipped.
   */
  private partition: number | undefined = undefined

  /**
   * Number of partitions the slot space is divided into. `1` is the
   * legacy/no-partitioning value and goes hand-in-hand with `partition`
   * being `undefined`.
   */
  private partitionCountValue: number = 1

  /**
   * Per-account lock-SOC addresses (one per partition). When `stamp()` sees
   * a chunk whose address matches one of these, it routes the write to the
   * lock SOC's reserved slot (= the partition index) within the same bucket,
   * bypassing the partition data-slot formula and the local counter bump.
   * Overstamping the same SOC at the same slot does not consume new slot
   * budget, so the heartbeat cadence is sustainable.
   *
   * Populated by `bindLockSocs()` once per stamper lifetime (deterministic
   * from accountId + partitionCount + owner). Independent of `partition`
   * binding so lock-SOC writes work both before and after `bindPartition`.
   */
  private lockSocs:
    | ReadonlyArray<{ partition: number; address: Uint8Array }>
    | undefined = undefined

  /**
   * Hex addresses of the utilisation (counter) chunks for the in-flight save,
   * mapped to the reserved SLOT each must overstamp. `stamp()` routes these to
   * that slot instead of a data slot. The slot is recorded at marking time
   * (not read from `this.partition` at stamp time) because the teardown
   * release publishes through an UNBOUND stamper — `partition` is already
   * undefined there, and falling back to slot 0 would overstamp the OTHER
   * partition's reserved chunks. Unlike the lock SOC, a counter chunk's
   * address changes whenever the counter changes, so writers register the
   * current set via `markReservedUtilizationChunk` and clear it with
   * `clearReservedUtilizationChunks`.
   */
  private reservedUtilizationChunks: Map<string, number> | undefined = undefined

  /**
   * The per-partition intent SOC for an in-flight intent round (Phase 2 —
   * `partition-intent.ts`), mapped to the reserved SLOT it must overstamp (the
   * contended partition index). Routed like the lock SOC / utilisation chunks:
   * `stamp()` places it in the partition's reserved slot, so it NEVER lands in
   * a data lane (`>= DATA_COUNTER_START`) and cannot overstamp user data.
   * Single-entry and self-clearing (set immediately before the upload, cleared
   * in a `finally`), so it stays isolated from the `reservedUtilizationChunks`
   * save lifecycle and never grows. See `reserveIntentSocSlot`.
   */
  private intentSoc: { addressHex: string; slot: number } | undefined =
    undefined

  /**
   * Promise-chain mutex serializing {@link withIntentSocSlot} critical sections.
   * The intent / occupancy / state-pointer SOC writes all share the single
   * {@link intentSoc} reservation, but their callers run concurrently (the
   * off-lock refresh-tick presence/occupancy beacon vs. an under-lock upload's
   * state-pointer publish). Without this, the two reserve→stamp windows overlap:
   * the second `reserveIntentSocSlot` clobbers the first's address, so the
   * first `stamp()` no longer matches `intentSoc` and falls through to a DATA
   * slot — consuming data budget and bumping the counter under the very publish
   * that is diffing it. The mutex makes each writer wait for the previous to
   * clear its reservation.
   */
  private intentSocLock: Promise<void> = Promise.resolve()

  /**
   * Circuit breaker for in-flight uploads. Flipped to `true` when the proxy
   * detects displacement on a refresh tick (or upload-start lease check), or
   * tears the lease down; subsequent data `stamp()` calls throw
   * `PartitionLeaseLostError` to abort the upload cleanly instead of silently
   * corrupting the peer's slot space. Outlives `unbindPartition` — an unbound
   * stamper would otherwise stamp the rest of that upload at legacy slots —
   * and is cleared only by the next `bindPartition`.
   */
  private leaseStale: boolean = false

  /**
   * Wall-clock ms this device's lease is valid until (from the lock SOC's
   * `leasedUntil`, pushed by the coordinator on bind and every renewal). While a
   * multi-chunk upload runs, each `stamp()` re-checks it locally (no network) and
   * throws once `Date.now()` passes it (minus a skew margin), so an un-renewable
   * holder stops writing mid-op the instant its own clock says the lease lapsed —
   * closing the "ack-safe, not write-safe" residual to the irreducible skew bound
   * (Postage-Batch-Partitioning.md §12). `undefined` = not fenced (legacy mode,
   * or between bind and the coordinator's first push).
   */
  private leaseValidUntil: number | undefined = undefined

  /**
   * This device's clock, injectable for tests (#385). The local-lapse fence
   * compares it against `leaseValidUntil`, so a test MUST drive the stamper with
   * the SAME clock it gives the `PartitionLease` (whose `leasedUntil` feeds
   * `leaseValidUntil`) — otherwise the two disagree and the fence mis-fires.
   * Defaults to `Date.now()` (production: one wall clock everywhere).
   */
  private readonly now: () => number

  /**
   * Per-partition buckets of the latest published partition-state chunks.
   * Utilisation saves must not place chunks in these buckets (same reserved
   * slot → overstamp → the published resume point is evicted from the
   * reserve). Mirrors `BatchMetadata.stateChunkBuckets`; restored on create.
   */
  private protectedStateBuckets = new Map<number, ReadonlySet<number>>()

  readonly signer: PrivateKey
  readonly batchId: BatchId
  readonly depth: number
  readonly maxSlot: number
  /**
   * A scratch drive (#862): a full lane wraps onto its oldest slot instead of
   * refusing. The counter keeps counting; only the slot is reduced.
   */
  readonly scratch: boolean
  /** The depth the counters serialize at — {@link counterLayoutDepth}. */
  readonly counterDepth: number

  /**
   * The next physical data slot per bucket, as core-sdk's `Stamper` means it.
   * A snapshot: the counters of record are lane-relative (`dataCounters`), so
   * writing here moves nothing — take a slot with {@link assignSlot}.
   * Allocates a fresh NUM_BUCKETS-entry array per call.
   */
  get buckets(): Uint32Array {
    return this.utilizationState.dataCounters.map((j) =>
      dataSlot(this.partition ?? 0, j, this.partitionCountValue),
    )
  }

  /** Current partition (undefined in single-device legacy mode). */
  get currentPartition(): number | undefined {
    return this.partition
  }

  /** Total partition count (1 in legacy mode). */
  get partitionCount(): number {
    return this.partitionCountValue
  }

  /**
   * Per-bucket local stamping counter, exposed so the lease orchestrator
   * can publish it to the partition-state feed on release. Returns
   * undefined in legacy mode.
   */
  getLocalCounter(): Uint32Array | undefined {
    return this.partition !== undefined
      ? this.utilizationState.dataCounters
      : undefined
  }

  /**
   * Buckets that contain a per-partition lock SOC. External callers that
   * persist utilisation chunks (e.g. `saveUtilizationState` from the sync
   * path) should treat these as already claimed so utilisation-chunk key
   * search avoids dropping a chunk on the lock SOC's bucket.
   */
  getLockSocBuckets(): ReadonlySet<number> {
    const set = new Set<number>()
    for (const soc of this.lockSocs ?? []) {
      set.add(toBucket(soc.address))
    }
    return set
  }

  /**
   * All buckets a utilisation save must avoid: the lock-SOC buckets plus the
   * buckets of the latest published partition-state chunks for the partition
   * this stamper writes reserved slots in (`partition ?? 0`). A utilisation
   * chunk landing in a published state chunk's bucket would overstamp the
   * same reserved slot and evict the published chunk from the reserve —
   * destroying the resume point a later takeover depends on.
   */
  getProtectedBuckets(): ReadonlySet<number> {
    const set = new Set<number>(this.getLockSocBuckets())
    const stateBuckets = this.protectedStateBuckets.get(this.partition ?? 0)
    for (const bucket of stateBuckets ?? []) {
      set.add(bucket)
    }
    return set
  }

  /**
   * Buckets occupied by this stamper's current CLEAN utilisation chunks.
   * The partition-state publish avoids them so a randomly-keyed state chunk
   * does not evict a live utilisation chunk from the reserve.
   */
  getCleanChunkBuckets(): ReadonlySet<number> {
    return claimedBucketsForCleanChunks(this.utilizationState)
  }

  /**
   * Record the buckets occupied by the latest published partition-state
   * chunks for `partition` (in memory + persisted in the batch metadata, so
   * a reload keeps avoiding them). Called after every successful publish
   * (`PartitionLease.release`) and after every successful state read
   * (`claimPartition`) — the set is replaced wholesale; only the latest
   * publish needs protection, superseded chunks are dead.
   */
  async setProtectedStateBuckets(
    partition: number,
    buckets: number[],
  ): Promise<void> {
    this.protectedStateBuckets.set(partition, new Set(buckets))
    const batchId = this.batchId.toHex()
    const existing = await this.cache.getMetadata(batchId)
    await this.cache.putMetadata({
      batchId,
      lastSync: existing?.lastSync ?? Date.now(),
      chunkCount: existing?.chunkCount ?? 0,
      syncedReferences: existing?.syncedReferences,
      stateChunkBuckets: {
        ...(existing?.stateChunkBuckets ?? {}),
        [partition]: buckets,
      },
    })
  }

  /**
   * Bind this stamper to a leased partition. Called once by the lease
   * orchestrator after `acquire()` succeeds. `localCounter` is the
   * starting per-bucket count for THIS device — fresh zeros for Case A,
   * the resumed high-water from the state feed for Cases B/D.
   */
  bindPartition(opts: {
    partition: number
    partitionCount: number
    localCounter: Uint32Array
  }): void {
    if (opts.localCounter.length !== NUM_BUCKETS) {
      throw new Error(
        `localCounter must have ${NUM_BUCKETS} entries, got ${opts.localCounter.length}`,
      )
    }
    this.partition = opts.partition
    this.partitionCountValue = opts.partitionCount
    // The seeded per-partition counter (`j`, resumed high-water for Cases
    // B/D) becomes the single counter of record for this held partition.
    this.utilizationState.dataCounters = opts.localCounter
    this.leaseStale = false
    // Presumed valid until the coordinator pushes the real `leasedUntil` (it
    // does so synchronously right after bind). Mirrors the `leaseStale` reset.
    this.leaseValidUntil = undefined
  }

  /**
   * Bind the per-partition lock-SOC addresses. Called once per stamper
   * lifetime (the addresses are deterministic from the account). Routes
   * lock-SOC overstamps to a fixed reserved slot per partition so the tight
   * heartbeat cadence doesn't consume new slot budget every refresh.
   *
   * Independent of `bindPartition` — can be called before the partition
   * lease is acquired (the first lock-SOC write inside `acquirePartitionLock`
   * needs this routing to already be in place).
   */
  bindLockSocs(
    socs: ReadonlyArray<{ partition: number; address: Uint8Array }>,
  ): void {
    this.lockSocs = socs
  }

  /**
   * Register a utilisation/state chunk address so the next `stamp()` of it
   * routes to a reserved slot instead of a data slot. `slot` defaults to the
   * currently bound partition — pass it explicitly when the stamper may be
   * unbound at stamp time (the teardown release publishes state chunks after
   * `unbindPartition()`, and a default of 0 would overstamp partition 0's
   * reserved chunks). Idempotent per address.
   */
  markReservedUtilizationChunk(address: Uint8Array, slot?: number): void {
    if (!this.reservedUtilizationChunks) {
      this.reservedUtilizationChunks = new Map()
    }
    this.reservedUtilizationChunks.set(
      uint8ArrayToHex(address),
      slot ?? this.partition ?? 0,
    )
  }

  /** Clear the registered utilisation-chunk addresses after a save. */
  clearReservedUtilizationChunks(): void {
    this.reservedUtilizationChunks = undefined
  }

  /**
   * Register the per-partition intent SOC so `stamp()` routes it to `slot`
   * (the contended partition's reserved index) instead of a data slot — never
   * consuming data budget or bumping the counter. `slot` is passed explicitly
   * because the intent round runs BEFORE `bindPartition`, so `this.partition`
   * is not yet set. Call immediately before the upload; pair with
   * `clearIntentSocSlot` in a `finally`.
   */
  reserveIntentSocSlot(address: Uint8Array, slot: number): void {
    this.intentSoc = { addressHex: uint8ArrayToHex(address), slot }
  }

  /** Clear the registered intent SOC after its upload. */
  clearIntentSocSlot(): void {
    this.intentSoc = undefined
  }

  /**
   * Reserve the intent-SOC slot for `address`, run `fn` (the upload), then
   * clear it — serialized against every other `withIntentSocSlot` call on this
   * stamper so concurrent intent/occupancy/state-pointer writes can't clobber
   * one another's reservation (see {@link intentSocLock}). Production callers
   * (`writeReservedPartitionSoc`, `writeStatePointer`) MUST use this instead of
   * the bare `reserveIntentSocSlot`/`clearIntentSocSlot` pair. `partition` is the
   * reserved slot index the SOC routes to (the contended partition's index).
   */
  async withIntentSocSlot<T>(
    address: Uint8Array,
    partition: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.intentSocLock
    let release!: () => void
    this.intentSocLock = new Promise<void>((resolve) => (release = resolve))
    await previous
    // `reserveIntentSocSlot` inside the try so `release()` still runs if it (or
    // `fn`) ever throws — otherwise `intentSocLock` would stay pending forever
    // and every later intent/occupancy/state-pointer write on this stamper would
    // deadlock on `await previous`.
    try {
      this.reserveIntentSocSlot(address, partition)
      return await fn()
    } finally {
      this.clearIntentSocSlot()
      release()
    }
  }

  /**
   * Inverse of `bindPartition` — clears partition slot state on demote.
   * Leaves `lockSocs` intact (still valid for the account; refresh/yield
   * writes may need them), and leaves an invalidated lease invalidated: see
   * `leaseStale`.
   */
  unbindPartition(): void {
    this.partition = undefined
    this.partitionCountValue = 1
    this.leaseValidUntil = undefined
  }

  /**
   * Circuit-break: mark the bound lease as stale. Every data `stamp()` from
   * here to the next `bindPartition` throws `PartitionLeaseLostError`, so an
   * in-flight upload aborts cleanly mid-stream when a peer takes our partition
   * or the lease is torn down under it. No-op when no partition is bound:
   * there is no lease to lose, and legacy stamping must stay unfenced.
   */
  invalidateLease(): void {
    if (this.partition === undefined) return
    this.leaseStale = true
  }

  /**
   * Record the wall-clock ms this device's lease is valid until (the lock SOC's
   * `leasedUntil`). The coordinator pushes it on bind and every successful
   * renewal; `undefined` disables the local-lapse fence. See `leaseValidUntil`.
   */
  setLeaseValidUntil(ms: number | undefined): void {
    this.leaseValidUntil = ms
  }

  /**
   * True when this device's own clock says the lease has lapsed (or is within
   * the skew margin of it). Pure/local — no network — so it can gate every
   * `stamp()` on the hot path for free. `undefined` deadline → not fenced.
   */
  private leaseLocallyLapsed(): boolean {
    return (
      this.leaseValidUntil !== undefined &&
      this.now() >= this.leaseValidUntil - LEASE_SKEW_MARGIN_MS
    )
  }

  private constructor(
    signer: PrivateKey,
    batchId: BatchId,
    depth: number,
    cache: UtilizationStoreDB,
    encryptionKey: Uint8Array,
    utilizationState: BatchUtilizationState,
    now: () => number,
    scratch: boolean,
  ) {
    this.signer = signer
    this.batchId = batchId
    this.depth = depth
    this.maxSlot = calculateMaxSlotsPerBucket(depth)
    this.scratch = scratch
    this.counterDepth = counterLayoutDepth(depth, scratch)
    this.cache = cache
    this.encryptionKey = encryptionKey
    this.utilizationState = utilizationState
    this.now = now
  }

  /**
   * Create a UtilizationAwareStamper with bucket state from cache
   *
   * @param privateKey - Signer private key
   * @param batchId - Postage batch ID
   * @param depth - Batch depth
   * @param cache - Utilization cache database
   * @param _owner - Owner address (required for validation, reserved for future Swarm upload)
   * @param encryptionKey - Encryption key used to compute the canonical Swarm chunk address on local flush. Both call sites already pass the account's encryption key; "anything stable" works for now, will be tied to multi-device collision avoidance later.
   * @returns New UtilizationAwareStamper instance
   */
  static async create(
    privateKey: Uint8Array | string,
    batchId: BatchId,
    depth: number,
    cache: UtilizationStoreDB,
    owner: EthAddress,
    encryptionKey: Uint8Array,
    now: () => number = () => Date.now(),
    options: { scratch?: boolean } = {},
  ): Promise<UtilizationAwareStamper> {
    const scratch = options.scratch === true
    const layoutDepth = counterLayoutDepth(depth, scratch)
    // Initialize utilization state (always, since owner is now required)
    const utilizationState = initializeBatchUtilization(batchId, layoutDepth)

    // Try to load utilization state from cache
    try {
      const cachedChunks = await cache.getAllChunks(batchId.toHex())
      const { numUtilizationChunks } = getChunkLayout(layoutDepth)
      // Merge cached chunks into state; ignore any that fall outside the
      // current depth's layout (e.g. stale entries from a different depth)
      for (const cached of cachedChunks) {
        if (cached.chunkIndex >= numUtilizationChunks) continue
        mergeChunk(
          utilizationState.dataCounters,
          cached.chunkIndex,
          cached.data,
          layoutDepth,
        )
      }
    } catch (error) {
      console.warn(
        `[UtilizationAwareStamper] Failed to load state from cache, starting with fresh state:`,
        error,
      )
    }

    const instance = new UtilizationAwareStamper(
      new PrivateKey(privateKey),
      batchId,
      depth,
      cache,
      encryptionKey,
      utilizationState,
      now,
      scratch,
    )

    // Restore the protected partition-state buckets so saves keep avoiding
    // the published resume point across reloads. Tolerates minimal caches
    // (tests stub only getAllChunks/putChunk).
    try {
      const meta = await cache.getMetadata?.(batchId.toHex())
      for (const [p, buckets] of Object.entries(
        meta?.stateChunkBuckets ?? {},
      )) {
        instance.protectedStateBuckets.set(Number(p), new Set(buckets))
      }
    } catch (error) {
      console.warn(
        `[UtilizationAwareStamper] Failed to restore protected state buckets:`,
        error,
      )
    }

    // Auto-bind lock SOCs for all partitions. The lock-SOC owner is the
    // BACKUP signer's address — same value `writePartitionLock` derives
    // internally — NOT the `owner` parameter callers pass (which is the
    // account / postage-signer address depending on call site). Deriving
    // here from `encryptionKey` (= swarmEncryptionKey at every call site)
    // makes the routing self-consistent regardless of caller. Harmless for
    // single-device legacy accounts (the lock SOCs are never written).
    void owner // currently unused; reserved for a future Swarm upload path.
    const swarmEncryptionKeyHex = uint8ArrayToHex(encryptionKey)
    const backupKeyHex = await deriveSecret(
      swarmEncryptionKeyHex,
      BACKUP_KEY_LABEL,
    )
    const backupSigner = new PrivateKey(backupKeyHex)
    const backupOwner = backupSigner.publicKey().address()
    instance.lockSocs = Array.from({ length: PARTITION_COUNT }, (_, p) => ({
      partition: p,
      address: lockSocAddress(batchId, p, backupOwner),
    }))

    return instance
  }

  /**
   * Pick the slot `chunkAddress` is stamped at within its bucket, and spend it.
   *
   * Synchronous on purpose: callers fire stamps concurrently, and with no await
   * in here each assignment runs to completion before the next starts. Whoever
   * signs — {@link stamp} here, a `StampWorkerPool` worker — must take the slot
   * from this method and nowhere else.
   *
   * @throws PartitionLeaseLostError when the bound partition's lease is gone
   */
  assignSlot(chunkAddress: Uint8Array): number {
    // The three reserved-slot returns below skip the `maxSlot` bound: every
    // reserved slot is below `partitionCount`, so it always fits. A data slot
    // must never be returned from here — those take the bounded path at the end.
    //
    // Lock-SOC short-circuit: when stamping our own per-partition lock SOC,
    // overstamp the fixed reserved slot (= partition index, 0 or 1) within
    // its bucket. Doesn't consume new slot budget, doesn't bump our local
    // counter — the SOC address is the same on every refresh, so the slot
    // it occupies stays the same too.
    const lockSoc = this.lockSocs?.find((soc) =>
      Binary.equals(soc.address, chunkAddress),
    )
    if (lockSoc) {
      return lockSoc.partition
    }

    // Utilisation-chunk short-circuit: a counter/state chunk overstamps its
    // bucket's reserved slot (recorded at marking time), just like the lock
    // SOC. Persisting the counter therefore never consumes a data slot or
    // bumps the counter. The addresses are content-derived (they change as the
    // counter changes), so writers register the current save's addresses via
    // `markReservedUtilizationChunk` before uploading them.
    const addressHex = uint8ArrayToHex(chunkAddress)
    const reservedSlot = this.reservedUtilizationChunks?.get(addressHex)
    if (reservedSlot !== undefined) {
      return reservedSlot
    }

    // Intent-SOC short-circuit: a partition-intent chunk (Phase 2) overstamps
    // the contended partition's reserved slot — like the lock SOC, below the
    // data lanes — so it can never collide with user data. Doesn't bump the
    // counter. Not gated by `leaseStale`: the intent round runs before binding,
    // while no lease is held.
    if (this.intentSoc?.addressHex === addressHex) {
      return this.intentSoc.slot
    }

    // Partition lease was reclaimed — abort cleanly before the stamp lands in
    // slot space the peer now controls. Single-device legacy mode has no lease
    // to invalidate, so neither condition can hold there. Two conditions:
    //  - `leaseStale`: the refresh tick CONFIRMED a peer took over (write-verify
    //    failed / displacement beacon seen), or the coordinator tore the lease
    //    down. Holds across the unbind that follows, where the fall-through
    //    below would stamp at legacy slots.
    //  - `leaseLocallyLapsed()`: this device's own clock says the lease expired
    //    (skew margin applied). Catches the un-renewable case a disjoint-gateway
    //    refresh can't confirm by reading — stops a long op mid-stream the moment
    //    the lease lapses locally, so the data write is fenced to the same skew
    //    bound as the ack (Postage-Batch-Partitioning.md §12, "ack-safe").
    if (
      this.leaseStale ||
      (this.partition !== undefined && this.leaseLocallyLapsed())
    ) {
      throw new PartitionLeaseLostError()
    }

    // This device's next slot in its partition's lane: slot = partitionCount +
    // partition + partitionCount·j, where j is the per-partition counter.
    // Legacy single-device is partition 0, K=1 (data from slot 1, reserved
    // slot 0).
    // On a scratch drive the lane is a ring: past its capacity `j` wraps onto
    // the lane's oldest slot, which the new stamp's later timestamp lets Bee
    // overwrite. The counter itself stays monotonic, so the partition-state
    // publish's regression tripwire holds unchanged.
    const bucket = toBucket(chunkAddress)
    const counter = this.utilizationState.dataCounters[bucket]
    const capacity = partitionCapacity(this.depth, this.partitionCountValue)
    const slot = dataSlot(
      this.partition ?? 0,
      this.scratch && capacity > 0 ? counter % capacity : counter,
      this.partitionCountValue,
    )
    if (slot >= this.maxSlot) {
      throw new Error("Bucket is full")
    }

    // Advance the per-partition counter so the next stamp into this bucket
    // lands on this partition's next slot.
    this.utilizationState.dataCounters[bucket]++

    // Mark bucket as dirty for eventual flush
    this.dirtyBuckets.add(bucket)
    this.dirty = true

    return slot
  }

  /**
   * Stamp a chunk address (implements Stamper interface)
   *
   * @param chunkAddress - Address of the chunk to stamp
   * @param timestampMs - Stamp timestamp, defaults to now
   * @returns Envelope with batch ID and signature
   */
  stamp(chunkAddress: Uint8Array, timestampMs?: number): EnvelopeWithBatchId {
    return stampAtSlot(
      this.signer,
      this.batchId,
      chunkAddress,
      this.assignSlot(chunkAddress),
      timestampMs,
    )
  }

  /**
   * Get bucket state (implements Stamper interface) — see {@link buckets}.
   */
  getState(): Uint32Array {
    return this.buckets
  }

  /**
   * Flush dirty utilization chunks to cache
   *
   * This persists any bucket state changes made during stamping.
   * Should be called after all stamping operations are complete.
   */
  async flush(): Promise<void> {
    if (!this.dirty) {
      return
    }

    // Mark utilization chunks as dirty for the affected buckets
    const dirtyChunkIndexes = new Set<number>()
    for (const bucket of this.dirtyBuckets) {
      const chunkIndex = getChunkIndexForBucket(bucket, this.counterDepth)
      dirtyChunkIndexes.add(chunkIndex)
      this.utilizationState.chunks[chunkIndex].dirty = true
    }

    // Save dirty chunks to cache. We do not upload here, but we still record
    // the contentHash that an upload *would* assign — i.e. the BMT address of
    // the encrypted chunk for this plaintext + the per-chunk derived key. That
    // is what the upload-path dedup at saveUtilizationState compares against,
    // so storing anything else (or using a different key) would force a
    // redundant re-upload of every flushed chunk on the next sync.
    try {
      const claimedBuckets = claimedBucketsForCleanChunks(this.utilizationState)
      // Reserve each partition's lock-SOC bucket so utilisation-chunk key
      // search picks a different nonce. Otherwise a utilisation chunk could
      // land in the same bucket and try to claim slot 0/1 — the slot the
      // lock SOC overstamps every refresh.
      for (const soc of this.lockSocs ?? []) {
        claimedBuckets.add(toBucket(soc.address))
      }
      // Also reserve the latest published partition-state chunks' buckets —
      // they share this partition's reserved slot, and overstamping one
      // evicts the resume point a later takeover depends on.
      for (const bucket of this.protectedStateBuckets.get(
        this.partition ?? 0,
      ) ?? []) {
        claimedBuckets.add(bucket)
      }
      const sortedDirtyChunkIndexes = Array.from(dirtyChunkIndexes).sort(
        (a, b) => a - b,
      )
      for (const chunkIndex of sortedDirtyChunkIndexes) {
        const chunkData = extractChunk(
          this.utilizationState.dataCounters,
          chunkIndex,
          this.counterDepth,
        )

        const resolved = await chooseUtilizationChunkKey({
          swarmEncryptionKey: this.encryptionKey,
          batchId: this.batchId,
          chunkIndex,
          plaintext: chunkData,
          priorNonce: this.utilizationState.chunks[chunkIndex].nonce,
          claimedBuckets,
        })
        const contentHash = Binary.uint8ArrayToHex(resolved.address)

        await this.cache.putChunk({
          batchId: this.batchId.toHex(),
          chunkIndex,
          data: chunkData,
          contentHash,
          nonce: resolved.nonce,
          lastAccess: Date.now(),
        })
        this.utilizationState.chunks[chunkIndex].contentHash = contentHash
        this.utilizationState.chunks[chunkIndex].nonce = resolved.nonce
        this.utilizationState.chunks[chunkIndex].dirty = false
      }

      // Update lastSync timestamp
      this.utilizationState.lastSync = Date.now()
    } catch (error) {
      console.error(
        `[UtilizationAwareStamper] Failed to flush to cache:`,
        error,
      )
      throw error
    }

    // Clear dirty flags
    this.dirtyBuckets.clear()
    this.dirty = false
  }

  /**
   * Get current utilization state
   *
   * @returns Current utilization state
   */
  getUtilizationState(): BatchUtilizationState {
    return this.utilizationState
  }

  /**
   * Apply utilization update from another tab.
   * Updates local bucket counters to match leader's state.
   *
   * @param buckets Array of bucket indices and their new counter values
   */
  applyUtilizationUpdate(
    buckets: Array<{ index: number; value: number }>,
  ): void {
    for (const { index, value } of buckets) {
      if (index >= 0 && index < NUM_BUCKETS) {
        // Only update if the incoming value is higher (monotonic increase)
        if (value > this.utilizationState.dataCounters[index]) {
          this.utilizationState.dataCounters[index] = value
        }
      }
    }

    // Note: Do NOT clear dirtyBuckets here - those represent local writes
    // that still need to be flushed. Only flush() should clear them.
  }

  /**
   * Build the partition-local counter from the stamper's current
   * `dataCounters` — i.e. resume exactly where this device left off. The
   * lease orchestrator passes the result into `bindPartition` as the seed
   * counter for a held partition.
   */
  buildLeaseLocalCounter(): Uint32Array {
    return this.utilizationState.dataCounters.slice()
  }

  /**
   * Read the cached "synced reference" for `partition` — the partition-state
   * feed reference this device's local counter was last in sync with. Used by
   * the acquire path to skip re-downloading unchanged counter chunks.
   */
  async getSyncedReference(partition: number): Promise<string | undefined> {
    const meta = await this.cache.getMetadata(this.batchId.toHex())
    return meta?.syncedReferences?.[partition]
  }

  /**
   * Record the partition-state feed reference this device's local counter is
   * now in sync with (after a download or a publish). Merges into the existing
   * batch metadata so other fields / partitions are preserved.
   */
  async setSyncedReference(
    partition: number,
    referenceHex: string,
  ): Promise<void> {
    const batchId = this.batchId.toHex()
    const existing = await this.cache.getMetadata(batchId)
    await this.cache.putMetadata({
      batchId,
      lastSync: existing?.lastSync ?? Date.now(),
      chunkCount: existing?.chunkCount ?? 0,
      syncedReferences: {
        ...(existing?.syncedReferences ?? {}),
        [partition]: referenceHex,
      },
      stateChunkBuckets: existing?.stateChunkBuckets,
    })
  }

  /**
   * Get bucket counter values for broadcasting to other tabs.
   * Returns only the dirty buckets with their current values.
   *
   * IMPORTANT: Call this BEFORE flush() as flush() clears dirtyBuckets.
   *
   * @returns Array of bucket index/value pairs for broadcasting
   */
  getBucketUpdatesForBroadcast(): Array<{ index: number; value: number }> {
    return Array.from(this.dirtyBuckets).map((index) => ({
      index,
      value: this.utilizationState.dataCounters[index],
    }))
  }
}
