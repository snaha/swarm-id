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
import { rejectAfter } from "../utils/promise"
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
 * Epoch length for the rotating intent address. TTL-sized so a contention
 * round and its immediate retries share a bucket (and the previous bucket
 * covers the boundary), while every fresh round rotates to an address no node
 * has cached. Kept independent of the lock TTL constant to avoid a circular
 * import through batch-utilization; the two are intended to track each other.
 */
export const INTENT_EPOCH_MS = 30_000

/**
 * Client-side timeout for a single rival-intent read. Bee has no fast
 * authoritative "not found" — a retrieval of an absent chunk fails only after
 * exhausting peers — so an absent rival would otherwise block for tens of
 * seconds. A present chunk in its neighborhood retrieves well under this; a
 * timed-out read is treated as "no intent from that device".
 */
export const INTENT_READ_TIMEOUT_MS = 2500

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

/** Internal marker so a timed-out read is distinguishable from a real error. */
const INTENT_TIMEOUT_MESSAGE = "intent read timed out"

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
  const payload: PartitionIntentPayload = {
    deviceId: opts.deviceId,
    generation: opts.generation,
    ...(opts.leasedUntil !== undefined
      ? { leasedUntil: opts.leasedUntil }
      : {}),
  }
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const target: UploadTarget = {
    mode: "stamper",
    bee: opts.bee,
    stamper: opts.stamper,
  }

  // Route the intent to the contended partition's reserved slot so it can
  // never land in a data lane and overstamp user data (see module header).
  // Only the partition-aware stamper can do this; a plain stamper (legacy
  // single-device) never contends, so a normal upload is fine there.
  const stamper = opts.stamper
  if (stamper instanceof UtilizationAwareStamper) {
    const owner = opts.backupSigner.publicKey().address()
    const address = intentSocAddress(
      opts.partition,
      opts.deviceId,
      opts.epochBucket,
      owner,
    )
    stamper.reserveIntentSocSlot(address, opts.partition)
    try {
      await uploadSOC(target, opts.backupSigner, identifier, data, {
        encryptionKey: opts.swarmEncryptionKey,
      })
    } finally {
      stamper.clearIntentSocSlot()
    }
    return
  }

  await uploadSOC(target, opts.backupSigner, identifier, data, {
    encryptionKey: opts.swarmEncryptionKey,
  })
}

/**
 * Read a single rival's intent for (partition, epochBucket), bounded by
 * `timeoutMs`. Returns `undefined` when the chunk is missing, the read times
 * out (treated as "no intent" — see module header), or the payload is
 * malformed.
 */
export async function readPartitionIntent(opts: {
  bee: Bee
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  epochBucket: number
  timeoutMs?: number
}): Promise<PartitionIntentPayload | undefined> {
  const identifier = makePartitionIntentIdentifier(
    opts.partition,
    opts.deviceId,
    opts.epochBucket,
  )
  const owner = opts.backupSigner.publicKey().address()
  try {
    const soc = await Promise.race([
      downloadEncryptedSOC(
        opts.bee,
        owner,
        identifier,
        opts.swarmEncryptionKey,
      ),
      rejectAfter(
        opts.timeoutMs ?? INTENT_READ_TIMEOUT_MS,
        INTENT_TIMEOUT_MESSAGE,
      ),
    ])
    const parsed = PartitionIntentPayloadSchemaV1.safeParse(
      JSON.parse(new TextDecoder().decode(soc.payload)),
    )
    if (!parsed.success) {
      console.log(
        `[partition-intent] read device=${opts.deviceId} p=${opts.partition} bucket=${opts.epochBucket}: malformed`,
      )
      return undefined
    }
    console.log(
      `[partition-intent] read device=${opts.deviceId} p=${opts.partition} bucket=${opts.epochBucket}: FOUND (gen ts=${parsed.data.generation.timestampMs} leasedUntil=${parsed.data.leasedUntil ?? "none"})`,
    )
    return parsed.data
  } catch (error) {
    // Distinguish a timeout (the rival's chunk may well exist but the gateway
    // didn't retrieve it within the budget) from a genuine not-found — a
    // too-short timeout would silently re-enable the dual-acquire this whole
    // mechanism exists to prevent.
    const timedOut =
      error instanceof Error && error.message === INTENT_TIMEOUT_MESSAGE
    console.log(
      `[partition-intent] read device=${opts.deviceId} p=${opts.partition} bucket=${opts.epochBucket}: ${
        timedOut
          ? `TIMEOUT (>${opts.timeoutMs ?? INTENT_READ_TIMEOUT_MS}ms)`
          : `missing (${error instanceof Error ? error.message : String(error)})`
      } — treated as no-intent`,
    )
    return undefined
  }
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
  //  - a LIVE holder (beacon with `leasedUntil > now`) — already holds it,
  //    regardless of generation; or
  //  - a contender ordering strictly below us (a pre-claim intent, no
  //    `leasedUntil`, smaller generation).
  // An EXPIRED beacon (`leasedUntil <= now`) is a departed holder — ignored.
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
          }),
        })),
      ),
    )
    for (const r of observed) {
      const intent = r.intent
      if (!intent) continue
      if (intent.leasedUntil !== undefined) {
        if (intent.leasedUntil > opts.now)
          return { rivalId: r.rivalId, reason: "live-beacon" }
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
  const guardWindowMs = opts.guardWindowMs ?? 0
  const guardPollMs = opts.guardPollMs ?? INTENT_GUARD_POLL_MS
  const polls = Math.max(1, Math.floor(guardWindowMs / guardPollMs) + 1)
  let beatenBy: Awaited<ReturnType<typeof sweep>>
  for (let i = 0; i < polls; i++) {
    if (i > 0) await sleep(guardPollMs)
    beatenBy = await sweep()
    if (beatenBy) break
  }

  const outcome = beatenBy ? "lose" : "win"
  console.log(
    `[partition-intent] round p=${opts.partition} self=${opts.deviceId} rivals=${rivals.length} polls=${polls} → ${outcome}` +
      (beatenBy
        ? ` (beaten by ${beatenBy.rivalId} via ${beatenBy.reason})`
        : ""),
  )

  return outcome
}
