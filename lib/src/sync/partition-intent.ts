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
 */

import { Bee, Identifier, PrivateKey, type Stamper } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { downloadEncryptedSOC } from "../proxy/download-data"
import { uploadSOC, type UploadTarget } from "../proxy/upload"
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
}): Promise<void> {
  const identifier = makePartitionIntentIdentifier(
    opts.partition,
    opts.deviceId,
    opts.epochBucket,
  )
  const payload: PartitionIntentPayload = {
    deviceId: opts.deviceId,
    generation: opts.generation,
  }
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const target: UploadTarget = {
    mode: "stamper",
    bee: opts.bee,
    stamper: opts.stamper,
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
        "intent read timed out",
      ),
    ])
    const parsed = PartitionIntentPayloadSchemaV1.safeParse(
      JSON.parse(new TextDecoder().decode(soc.payload)),
    )
    return parsed.success ? parsed.data : undefined
  } catch {
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

  // Read every rival's intent for both buckets in parallel; each read is
  // individually time-bounded so an absent rival doesn't stall the round.
  const reads = rivals.flatMap((rivalId) =>
    [currentBucket, previousBucket].map((bucket) =>
      readPartitionIntent({
        bee: opts.bee,
        backupSigner: opts.backupSigner,
        swarmEncryptionKey: opts.swarmEncryptionKey,
        partition: opts.partition,
        deviceId: rivalId,
        epochBucket: bucket,
        timeoutMs: opts.timeoutMs,
      }),
    ),
  )
  const observed = await Promise.all(reads)

  for (const intent of observed) {
    if (!intent) continue
    // A rival ordering strictly below us wins the partition; we back off.
    if (compareGenerations(intent.generation, opts.generation) < 0) {
      return "lose"
    }
  }
  return "win"
}
