// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-device partition-INTENT SOCs — Phase 2 of the partition-lock hardening
 * (see docs/Partition-Lock-Hardening-Plan.md, "Extension that covers the
 * symmetric case: per-device intent SOCs").
 *
 * The lock SOC lives at a single static address. Across disjoint gateways a
 * node serves that address from a frozen cache (no TTL, no invalidation), so
 * contenders for a *free* partition never see each other and all bind it —
 * the disjoint-gateway dual-acquire bug. Tweaking the guard/TTL timeouts can't
 * help: the failure is non-visibility, not propagation latency.
 *
 * Intent SOCs convert "mutable-SOC cache coherence" (which Swarm doesn't
 * guarantee) into "push-sync receipt + retrieval routing" (which it does):
 *
 *   identifier = keccak256("swarm-id-partition-intent-v1:" || partition
 *                          || ":" || deviceId || ":" || epochBucket)
 *   owner       = backup signer (shared across the account's devices)
 *   encryption  = swarmEncryptionKey
 *
 * Each contender writes ONLY its own intent address and reads every other
 * known device's intent address. A read of an address your node has never
 * written (and, because the address rotates per epoch, never retrieved
 * before) cannot be short-circuited from the local store — it forces a
 * network retrieval to the address's storage neighborhood, where the rival's
 * receipt-backed push-sync placed its replicas. So contenders see each other,
 * order themselves by `generation`, and only the unique global-minimum binds
 * the lock.
 *
 * Irreducible limit (documented): absence is unprovable on Swarm — a retrieval
 * timeout can't distinguish "no rival intent" from "the network failed to find
 * it". We treat a timed-out read as "no intent" to keep liveness (a single
 * flaky device must not deadlock), so the guarantee is "when the network
 * works, rivals are seen"; genuine network partition still falls back to the
 * existing guard + TTL + refresh backstop.
 *
 * Slot safety: an intent is stamped into the CONTENDED partition's reserved
 * slot (= the partition index, `< DATA_COUNTER_START`), via
 * `UtilizationAwareStamper.reserveIntentSocSlot`. It therefore can NEVER share
 * a postage `(bucket, slot)` with user data (data lives at
 * `>= DATA_COUNTER_START`) — a deterministic guarantee, not probabilistic.
 *
 * Two residuals remain (both ~1/65536 per contending pair per round, far rarer
 * than the systematic disjoint-gateway failure, and NOT closed here):
 *   - Two contenders for the same partition whose per-epoch intent addresses
 *     hash into the same bucket both route to that partition's reserved slot;
 *     the older loses its stamp and reads as "no intent", so on disjoint
 *     gateways both may "win" → a rare dual-acquire. (A verify-own-intent
 *     back-off or per-device slot would close it.)
 *   - An intent may overstamp the contended partition's own (stale) lock SOC
 *     (harmless — re-acquired) or a published state chunk (→ `readFailed` →
 *     read-only fallback). Liveness-only, never data loss.
 */

import {
  Bee,
  Identifier,
  PrivateKey,
  type EthAddress,
  type Stamper,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { downloadEncryptedSOC } from "../proxy/download-data"
import { uploadSOC, type UploadTarget } from "../proxy/upload"
import { UtilizationAwareStamper } from "../utils/batch-utilization"
import { TimeoutError, withTimeout } from "../utils/promise"
import { INTENT_EPOCH_MS, SYNC_READ_TIMEOUT_MS } from "./timing-constants"
import {
  PartitionIntentPayloadSchemaV1,
  type PartitionIntentPayload,
} from "../schemas"
import {
  compareGenerations,
  type PartitionLockGeneration,
} from "./partition-lock"

export type { PartitionIntentPayload }

/** Domain-separation tag for the intent-SOC identifier. */
const PARTITION_INTENT_DOMAIN = "swarm-id-partition-intent-v1"

/**
 * Domain tag for the per-(partition, epoch) OCCUPANCY beacon — deliberately
 * NOT keyed by deviceId. A holder publishes it on claim/refresh; any contender
 * reads it during `acquire` to detect a live holder **it has never heard of**
 * (the registry-lag dual-acquire: a re-claiming device whose roster hasn't yet
 * synced a peer is blind to that peer on every deviceId-keyed channel). The
 * address still rotates per epoch, so the read forces a network retrieval that
 * bypasses the frozen static-lock cache.
 */
const PARTITION_OCCUPANCY_DOMAIN = "swarm-id-partition-occupancy-v1"

// Epoch length for the rotating intent address (TTL-sized so a round + its
// retries share a bucket; every fresh round rotates to an uncached address).
// Single source in `sync/timing-constants` (= `LEASE_TTL_MS`), which the
// dependency-free module lets us share without a circular import.
export { INTENT_EPOCH_MS }

// Client-side timeout for a single rival-intent read — the shared cross-device
// read timeout (Bee has no fast authoritative "not found", so an absent rival
// would otherwise block for tens of seconds; a timed-out read is treated as
// "no intent from that device").
export const INTENT_READ_TIMEOUT_MS = SYNC_READ_TIMEOUT_MS

/**
 * Total window an intent round polls rivals before binding a fresh claim.
 * Sized to the gateway's write→cross-device-retrieve propagation delay: a peer
 * that wrote its intent/beacon seconds ago isn't immediately readable, so a
 * single read races ahead of propagation and misses it. Polling over this
 * window lets the peer surface. Tunable per gateway (lease/coordinator opts +
 * the `swarm-id-partition-tuning` localStorage override).
 */
export const INTENT_GUARD_WINDOW_MS = 12_000

/** Interval between rival re-reads within the guard window. */
export const INTENT_GUARD_POLL_MS = 2500

/**
 * Grace applied to a found beacon's `leasedUntil` when deciding liveness. A
 * beacon is only ever read at the current/previous epoch bucket, so a found one
 * was written ≤ ~2 epochs ago — bounded-fresh by its rotating address. Its
 * `leasedUntil` (writeTime + lock TTL ≈ 30s) can still lapse before the holder's
 * NEXT beacon becomes cross-device retrievable, so a live holder whose freshest
 * beacon hasn't propagated would be misread as departed. Treating a beacon as
 * live while `leasedUntil > now - GRACE` bridges that propagation gap; the
 * bucket-bounded read window means this can never resurrect an aged-out beacon.
 */
export const INTENT_LIVENESS_GRACE_MS = INTENT_EPOCH_MS

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** `floor(nowMs / INTENT_EPOCH_MS)` — the current intent epoch bucket. */
export function intentEpochBucket(nowMs: number): number {
  return Math.floor(nowMs / INTENT_EPOCH_MS)
}

/**
 * Build the per-(partition, device, epoch) intent-SOC identifier. The address
 * rotates with `epochBucket`, so it is fresh per contention round — neither
 * the writer's nor a reader's node has a cached copy.
 */
export function makePartitionIntentIdentifier(
  partition: number,
  deviceId: string,
  epochBucket: number,
): Identifier {
  const hash = Binary.keccak256(
    new TextEncoder().encode(
      `${PARTITION_INTENT_DOMAIN}:${partition}:${deviceId}:${epochBucket}`,
    ),
  )
  return new Identifier(hash)
}

/**
 * 32-byte SOC chunk address for an intent — `keccak256(identifier ‖ owner)`,
 * the same derivation `uploadSOC` uses. Computable before the upload so the
 * stamper can reserve the chunk's slot (route it to the contended partition's
 * reserved index instead of a data lane).
 */
export function intentSocAddress(
  partition: number,
  deviceId: string,
  epochBucket: number,
  owner: EthAddress,
): Uint8Array {
  const identifier = makePartitionIntentIdentifier(
    partition,
    deviceId,
    epochBucket,
  )
  return Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )
}

/** Build the deviceId-INDEPENDENT occupancy identifier for (partition, epoch). */
export function makePartitionOccupancyIdentifier(
  partition: number,
  epochBucket: number,
): Identifier {
  const hash = Binary.keccak256(
    new TextEncoder().encode(
      `${PARTITION_OCCUPANCY_DOMAIN}:${partition}:${epochBucket}`,
    ),
  )
  return new Identifier(hash)
}

/** 32-byte SOC address for an occupancy beacon (for stamper slot reservation). */
export function partitionOccupancyAddress(
  partition: number,
  epochBucket: number,
  owner: EthAddress,
): Uint8Array {
  const identifier = makePartitionOccupancyIdentifier(partition, epochBucket)
  return Binary.keccak256(
    Binary.concatBytes(identifier.toUint8Array(), owner.toUint8Array()),
  )
}

/**
 * Write this device's intent for (partition, epochBucket). The payload carries
 * the generation the device intends to claim with, so rivals can order against
 * it. Uses the shared backup signer as owner (same as the lock SOC); each
 * device only ever writes its own identifier.
 */
export async function writePartitionIntent(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  epochBucket: number
  generation: PartitionLockGeneration
  /**
   * Present when this write is a holder PRESENCE BEACON (re-published each
   * refresh): lets a reading joiner apply a `leasedUntil > now` liveness test.
   * Omitted for a pre-claim intent (the symmetric-race announce).
   */
  leasedUntil?: number
}): Promise<void> {
  const identifier = makePartitionIntentIdentifier(
    opts.partition,
    opts.deviceId,
    opts.epochBucket,
  )
  const owner = opts.backupSigner.publicKey().address()
  const address = intentSocAddress(
    opts.partition,
    opts.deviceId,
    opts.epochBucket,
    owner,
  )
  const payload: PartitionIntentPayload = {
    deviceId: opts.deviceId,
    generation: opts.generation,
    ...(opts.leasedUntil !== undefined
      ? { leasedUntil: opts.leasedUntil }
      : {}),
  }
  await writeReservedPartitionSoc({
    bee: opts.bee,
    stamper: opts.stamper,
    backupSigner: opts.backupSigner,
    swarmEncryptionKey: opts.swarmEncryptionKey,
    partition: opts.partition,
    identifier,
    address,
    payload,
  })
}

/**
 * Publish this device's OCCUPANCY beacon for (partition, epochBucket) — same
 * payload as a presence beacon but at the deviceId-independent occupancy
 * address, so a contender that doesn't know this device can still detect it
 * holds the partition. Always carries `leasedUntil` (it only ever announces a
 * live hold).
 */
export async function writePartitionOccupancy(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  epochBucket: number
  generation: PartitionLockGeneration
  leasedUntil: number
}): Promise<void> {
  const identifier = makePartitionOccupancyIdentifier(
    opts.partition,
    opts.epochBucket,
  )
  const owner = opts.backupSigner.publicKey().address()
  const address = partitionOccupancyAddress(
    opts.partition,
    opts.epochBucket,
    owner,
  )
  const payload: PartitionIntentPayload = {
    deviceId: opts.deviceId,
    generation: opts.generation,
    leasedUntil: opts.leasedUntil,
  }
  await writeReservedPartitionSoc({
    bee: opts.bee,
    stamper: opts.stamper,
    backupSigner: opts.backupSigner,
    swarmEncryptionKey: opts.swarmEncryptionKey,
    partition: opts.partition,
    identifier,
    address,
    payload,
  })
}

/**
 * Upload a partition SOC (intent / occupancy / beacon) routed to the contended
 * partition's RESERVED slot so it can never land in a data lane and overstamp
 * user data (see module header). Only the partition-aware stamper can reserve;
 * a plain stamper (legacy single-device) never contends, so a normal upload is
 * fine there.
 */
async function writeReservedPartitionSoc(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  identifier: Identifier
  address: Uint8Array
  payload: PartitionIntentPayload
}): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(opts.payload))
  const target: UploadTarget = {
    mode: "stamper",
    bee: opts.bee,
    stamper: opts.stamper,
  }
  const stamper = opts.stamper
  if (stamper instanceof UtilizationAwareStamper) {
    // Serialized against concurrent intent/occupancy/pointer SOC writes so a
    // peer reservation can't clobber this one and mis-stamp it into a data slot.
    await stamper.withIntentSocSlot(opts.address, opts.partition, () =>
      uploadSOC(target, opts.backupSigner, opts.identifier, data, {
        encryptionKey: opts.swarmEncryptionKey,
      }),
    )
    return
  }
  await uploadSOC(target, opts.backupSigner, opts.identifier, data, {
    encryptionKey: opts.swarmEncryptionKey,
  })
}

/** A 5xx is a transient gateway error, not proof the chunk is absent. */
const isServerError = (error: unknown): boolean =>
  error instanceof Error && /status code 5\d\d/.test(error.message)

/**
 * Download + parse an intent/occupancy SOC at `identifier`, bounded by
 * `timeoutMs`. Returns `undefined` when the chunk is missing, the read times
 * out (treated as "no intent" — see module header), or the payload is
 * malformed. A 5xx server error is RETRIED once before concluding absence: a
 * transient 500 is not evidence the chunk is gone, and treating it as such is
 * what let the dual-acquire slip through under a gateway 500 storm. A 404 /
 * timeout keeps the documented "absence assumed" (genuine for the rotating
 * address; preserves liveness).
 */
async function readPartitionSoc(opts: {
  bee: Bee
  owner: EthAddress
  identifier: Identifier
  swarmEncryptionKey: Uint8Array
  timeoutMs?: number
  logLabel: string
  /**
   * Retry once on a 5xx (default true). The intent ROUND polls — its own loop
   * already re-reads each sweep — so it passes false to avoid doubling per-read
   * latency + gateway load on a 500-storming node. Single-shot callers (holder
   * presence/occupancy reads) keep the retry so a transient 500 isn't misread as
   * "absent" (the dual-acquire guard).
   */
  retryOn5xx?: boolean
}): Promise<PartitionIntentPayload | undefined> {
  const download = () =>
    withTimeout(
      downloadEncryptedSOC(
        opts.bee,
        opts.owner,
        opts.identifier,
        opts.swarmEncryptionKey,
      ),
      opts.timeoutMs ?? INTENT_READ_TIMEOUT_MS,
      "intent read timed out",
    )

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const soc = await download()
      const parsed = PartitionIntentPayloadSchemaV1.safeParse(
        JSON.parse(new TextDecoder().decode(soc.payload)),
      )
      if (!parsed.success) {
        console.debug(`[partition-intent] ${opts.logLabel}: malformed`)
        return undefined
      }
      console.debug(
        `[partition-intent] ${opts.logLabel}: FOUND (gen ts=${parsed.data.generation.timestampMs} leasedUntil=${parsed.data.leasedUntil ?? "none"})`,
      )
      return parsed.data
    } catch (error) {
      // Retry once on a transient 5xx; a too-short timeout or a real 404 are
      // treated as absence so a single flaky device can't deadlock the round.
      if (isServerError(error) && attempt === 0 && opts.retryOn5xx !== false)
        continue
      const timedOut = error instanceof TimeoutError
      console.debug(
        `[partition-intent] ${opts.logLabel}: ${
          timedOut
            ? `TIMEOUT (>${opts.timeoutMs ?? INTENT_READ_TIMEOUT_MS}ms)`
            : `missing (${error instanceof Error ? error.message : String(error)})`
        }${isServerError(error) ? " after 5xx retry" : ""} — treated as no-intent`,
      )
      return undefined
    }
  }
  return undefined
}

/**
 * Read a single rival's intent for (partition, epochBucket). Returns `undefined`
 * when missing / timed out / malformed (treated as "no intent" — see header).
 */
export async function readPartitionIntent(opts: {
  bee: Bee
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  epochBucket: number
  timeoutMs?: number
  /** See `readPartitionSoc`. The polling round passes false. */
  retryOn5xx?: boolean
}): Promise<PartitionIntentPayload | undefined> {
  return readPartitionSoc({
    bee: opts.bee,
    owner: opts.backupSigner.publicKey().address(),
    identifier: makePartitionIntentIdentifier(
      opts.partition,
      opts.deviceId,
      opts.epochBucket,
    ),
    swarmEncryptionKey: opts.swarmEncryptionKey,
    timeoutMs: opts.timeoutMs,
    retryOn5xx: opts.retryOn5xx,
    logLabel: `read device=${opts.deviceId} p=${opts.partition} bucket=${opts.epochBucket}`,
  })
}

/**
 * Read the deviceId-INDEPENDENT occupancy beacon for (partition, epochBucket).
 * Lets a contender detect a live holder it doesn't know about.
 */
export async function readPartitionOccupancy(opts: {
  bee: Bee
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  epochBucket: number
  timeoutMs?: number
}): Promise<PartitionIntentPayload | undefined> {
  return readPartitionSoc({
    bee: opts.bee,
    owner: opts.backupSigner.publicKey().address(),
    identifier: makePartitionOccupancyIdentifier(
      opts.partition,
      opts.epochBucket,
    ),
    swarmEncryptionKey: opts.swarmEncryptionKey,
    timeoutMs: opts.timeoutMs,
    logLabel: `occupancy p=${opts.partition} bucket=${opts.epochBucket}`,
  })
}

/**
 * Run an intent round for a fresh claim of `partition`: announce our intent,
 * then read every other known device's intent for the current AND previous
 * epoch bucket (covering the rotation boundary). Returns whether this device
 * is the round's winner.
 *
 * Winner = the strictly-minimum generation (earliest `timestampMs`, then
 * smallest `tiebreaker`). We lose iff any rival's intent orders below ours.
 * `compareGenerations` is a total order and distinct devices never tie
 * (tiebreaker derives from `keccak256(deviceId)`), so exactly one contender
 * wins. With no known rivals we win by default (a brand-new device not yet in
 * the registry falls back to the existing guard + TTL behaviour).
 *
 * @returns `"win"` to proceed with the claim, `"lose"` to back off (read-only).
 */
export async function resolveIntentRound(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  generation: PartitionLockGeneration
  knownDeviceIds: string[]
  now: number
  timeoutMs?: number
  /**
   * Poll rivals over this window before deciding (default 0 = a single read,
   * used by tests). Sized to the gateway propagation delay so a peer's recent
   * intent/beacon surfaces before we bind. See `INTENT_GUARD_WINDOW_MS`.
   */
  guardWindowMs?: number
  /** Interval between polls within the guard window. */
  guardPollMs?: number
  /**
   * Release WATERMARK for this partition, when the caller observed it freed by
   * an explicit release sentinel. A rival's live presence beacon at or below
   * this generation is the just-released holder's lingering GHOST (still within
   * its lease TTL at a live per-epoch address, but no longer a claim), so it
   * must NOT lose us the round. A genuine post-release claimant has a strictly
   * newer generation and still beats us. Omitted → every live beacon counts.
   */
  releasedGeneration?: PartitionLockGeneration
}): Promise<"win" | "lose"> {
  const rivals = opts.knownDeviceIds.filter((id) => id !== opts.deviceId)
  if (rivals.length === 0) return "win"

  const currentBucket = intentEpochBucket(opts.now)
  const previousBucket = currentBucket - 1

  // Announce our intent in the current bucket BEFORE reading rivals, so a rival
  // racing us in the same round observes us too — no contender can both miss
  // every rival and bind.
  await writePartitionIntent({
    bee: opts.bee,
    stamper: opts.stamper,
    backupSigner: opts.backupSigner,
    swarmEncryptionKey: opts.swarmEncryptionKey,
    partition: opts.partition,
    deviceId: opts.deviceId,
    epochBucket: currentBucket,
    generation: opts.generation,
  })

  // One sweep: read every rival's intent for both buckets in parallel (each
  // read individually time-bounded), and return the first rival that beats us:
  //  - a LIVE holder (beacon with `leasedUntil > now - GRACE`) — already holds
  //    it, regardless of generation; or
  //  - a contender ordering strictly below us (a pre-claim intent, no
  //    `leasedUntil`, smaller generation).
  // A beacon lapsed beyond the grace window is a departed holder — ignored. The
  // grace covers a live holder whose freshest beacon hasn't propagated yet (its
  // still-retrievable previous-bucket beacon's TTL lapsed seconds ago).
  const sweep = async (): Promise<
    { rivalId: string; reason: "live-beacon" | "earlier-intent" } | undefined
  > => {
    const observed = await Promise.all(
      rivals.flatMap((rivalId) =>
        [currentBucket, previousBucket].map(async (bucket) => ({
          rivalId,
          intent: await readPartitionIntent({
            bee: opts.bee,
            backupSigner: opts.backupSigner,
            swarmEncryptionKey: opts.swarmEncryptionKey,
            partition: opts.partition,
            deviceId: rivalId,
            epochBucket: bucket,
            timeoutMs: opts.timeoutMs,
            // The round polls; don't double per-read latency/load with a retry.
            retryOn5xx: false,
          }),
        })),
      ),
    )
    for (const r of observed) {
      const intent = r.intent
      if (!intent) continue
      if (intent.leasedUntil !== undefined) {
        if (intent.leasedUntil > opts.now - INTENT_LIVENESS_GRACE_MS) {
          // A beacon at or below an observed release watermark is the
          // just-released holder's stale ghost — not a live claim. Ignore it so
          // a peer can take over the freed partition; a genuine post-release
          // claimant (strictly newer generation) still beats us below.
          if (
            opts.releasedGeneration &&
            compareGenerations(intent.generation, opts.releasedGeneration) <= 0
          )
            continue
          return { rivalId: r.rivalId, reason: "live-beacon" }
        }
        continue
      }
      if (compareGenerations(intent.generation, opts.generation) < 0)
        return { rivalId: r.rivalId, reason: "earlier-intent" }
    }
    return undefined
  }

  // Poll across the guard window. A peer's freshly-written intent/beacon takes
  // a few seconds to become cross-device-retrievable on a gateway, so a single
  // immediate read races ahead of propagation. We back off as soon as ANY sweep
  // finds a beating rival; we only win after the whole window stays clear.
  // Poll until an ABSOLUTE deadline, not a fixed count: each sweep's reads are
  // unbounded (an absent read on a flaky gateway blocks up to the read timeout),
  // so a fixed poll count lets one round overrun its window by multiples and
  // blow the acquire budget. A wall-clock deadline keeps the round ≈ the guard
  // window (+ one in-flight sweep) regardless of read latency or rival count.
  const guardWindowMs = opts.guardWindowMs ?? 0
  const guardPollMs = opts.guardPollMs ?? INTENT_GUARD_POLL_MS
  const end = Date.now() + guardWindowMs
  let beatenBy: Awaited<ReturnType<typeof sweep>>
  let polls = 0
  do {
    if (polls > 0) await sleep(guardPollMs)
    polls++
    beatenBy = await sweep()
    if (beatenBy) break
  } while (Date.now() < end)

  const outcome = beatenBy ? "lose" : "win"
  console.debug(
    `[partition-intent] round p=${opts.partition} self=${opts.deviceId} rivals=${rivals.length} polls=${polls} → ${outcome}` +
      (beatenBy
        ? ` (beaten by ${beatenBy.rivalId} via ${beatenBy.reason})`
        : ""),
  )

  return outcome
}
