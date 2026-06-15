// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-partition lock SOC for multi-device postage-batch sharing.
 *
 * A single shared SOC per partition is the cross-device authority for "who
 * holds this partition". Multiple devices share the `backupSigner` so any of
 * them can write the SOC; concurrent writers are ordered deterministically by
 * a (timestampMs, tiebreaker) fencing token.
 *
 *   identifier = keccak256("swarm-id-partition-lock-v1:" || partition)
 *   owner       = backup signer (shared across the account's devices)
 *   encryption  = swarmEncryptionKey
 *
 * The identifier only carries the partition number — domain separation
 * across accounts comes from the per-account `owner` (derived from each
 * account's `derivationKey`), so the SOC address still differs per account
 * without needing accountId in the identifier hash.
 *
 * Protocol (acquire / takeover / refresh):
 *   1. Read the lock SOC.
 *   2. If a live foreign holder exists → return "blocked" without writing.
 *   3. Otherwise write our claim, wait `guardMs`, re-read.
 *   4. If our generation is still the latest visible → "acquired".
 *      If a higher generation was written during the guard → "lost-race".
 *
 * See the "Multi-Device Postage Batches" page in docs-site for the full design.
 */

import { Bee, PrivateKey, type Stamper } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { downloadEncryptedSOC } from "../proxy/download-data"
import { uploadSOC, type UploadTarget } from "../proxy/upload"
import { makePartitionLockIdentifier } from "../utils/lock-soc"
import {
  PartitionLockPayloadSchemaV1,
  type PartitionLockGeneration,
  type PartitionLockPayload,
} from "../schemas"

// Re-export the wire-format types (the Zod schema is the source of truth, in
// `../schemas`) so existing callers keep importing them from this module.
export type { PartitionLockGeneration, PartitionLockPayload }

// Re-export so external callers continue to import these from the
// partition-lock module (the implementations live in utils/lock-soc.ts to
// avoid a circular dependency with batch-utilization.ts).
export {
  lockSocAddress,
  lockSocBucket,
  makePartitionLockIdentifier,
} from "../utils/lock-soc"

/** Number of bytes from `keccak256(deviceId)` to use as the tiebreaker. */
const TIEBREAKER_BYTES = 8

/**
 * Sentinel value placed in `holderDeviceId` to indicate "no current holder"
 * (e.g. after an explicit release).
 */
export const NO_HOLDER_DEVICE_ID = ""

/**
 * Outcome of an `acquirePartitionLock` call.
 *
 * - `"acquired"` — the lock is now held by this device (write + verify both
 *   succeeded).
 * - `"blocked"` — a live foreign holder exists; no write was performed.
 * - `"lost-race"` — we wrote, but a higher-generation writer appeared
 *   during the guard window. The verify-read returned that other write.
 * - `"aborted"` — `shouldAbort` flipped before the claim write (the owning
 *   lease session closed, e.g. a release started); no write was performed.
 */
export interface AcquirePartitionLockResult {
  outcome: "acquired" | "blocked" | "lost-race" | "aborted"
  /** Latest payload observed by this call (after the verify-read). */
  payload: PartitionLockPayload | undefined
}

/**
 * Outcome of a `releasePartitionLock` call.
 *
 * - `"released"` — the release sentinel was written.
 * - `"skipped"` — the lock no longer carries the claim being released
 *   (successor claim, peer claim, or an existing sentinel); writing the
 *   sentinel would clobber state that is not ours to release. The lock is
 *   left untouched.
 */
export interface ReleasePartitionLockResult {
  outcome: "released" | "skipped"
  /** Payload observed by the pre-write read (undefined when missing/unreadable). */
  observed?: PartitionLockPayload
}

/**
 * Compute the per-device tiebreaker: first 8 bytes of `keccak256(deviceId)`
 * as a hex string. Two different deviceIds collide with probability 2⁻⁶⁴.
 */
export function makeDeviceTiebreaker(deviceId: string): string {
  const hash = Binary.keccak256(new TextEncoder().encode(deviceId))
  return Binary.uint8ArrayToHex(hash.slice(0, TIEBREAKER_BYTES))
}

/**
 * Deterministic per-device starting partition: `keccak256(deviceId) mod
 * partitionCount`. Distinct devices map to distinct home partitions with high
 * probability, so they spread across slots even when none can read peers' lock
 * SOCs (the disjoint-gateway frozen-cache case — see
 * docs/Partition-Lock-Hardening-Plan.md). Only changes the selection scan
 * ORDER; visibly-held slots are still skipped, so behaviour under working
 * reads is unchanged.
 *
 * ponytail: probabilistic spread, not mutual exclusion — colliding home
 * partitions still race. The complete cross-gateway fix is the Phase 2
 * intent-SOC protocol in the hardening plan.
 */
export function deviceHomePartition(
  deviceId: string,
  partitionCount: number,
): number {
  const hash = Binary.keccak256(new TextEncoder().encode(deviceId))
  const n = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0
  return n % partitionCount
}

/**
 * Lexicographic comparison of two generations: timestamp first, then
 * tiebreaker. Returns -1 / 0 / 1.
 */
export function compareGenerations(
  a: PartitionLockGeneration,
  b: PartitionLockGeneration,
): -1 | 0 | 1 {
  if (a.timestampMs !== b.timestampMs) {
    return a.timestampMs < b.timestampMs ? -1 : 1
  }
  if (a.tiebreaker !== b.tiebreaker) {
    return a.tiebreaker < b.tiebreaker ? -1 : 1
  }
  return 0
}

/**
 * Read the partition-lock SOC. Returns `undefined` when the SOC has never
 * been written (the underlying chunk is missing on the Bee node).
 */
export async function readPartitionLock(opts: {
  bee: Bee
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
}): Promise<PartitionLockPayload | undefined> {
  const { bee, backupSigner, swarmEncryptionKey, partition } = opts
  const identifier = makePartitionLockIdentifier(partition)
  const owner = backupSigner.publicKey().address()
  try {
    const soc = await downloadEncryptedSOC(
      bee,
      owner,
      identifier,
      swarmEncryptionKey,
    )
    const parsed = PartitionLockPayloadSchemaV1.safeParse(
      JSON.parse(new TextDecoder().decode(soc.payload)),
    )
    // A payload that doesn't match the schema (foreign/corrupt/old format)
    // is treated the same as a missing lock — see the catch below.
    return parsed.success ? parsed.data : undefined
  } catch {
    // Missing chunk, decryption failure, or malformed JSON — treat all
    // as "lock unobserved". Callers (acquirePartitionLock) treat undefined
    // as "first acquire".
    return undefined
  }
}

/**
 * Overwrite the partition-lock SOC with `payload`. LWW per SOC identifier
 * — any prior chunk at this address is replaced (modulo Swarm propagation
 * delay).
 */
export async function writePartitionLock(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  payload: PartitionLockPayload
}): Promise<void> {
  const { bee, stamper, backupSigner, swarmEncryptionKey, partition, payload } =
    opts
  const identifier = makePartitionLockIdentifier(partition)
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  await uploadSOC(target, backupSigner, identifier, data, {
    encryptionKey: swarmEncryptionKey,
  })
}

/**
 * Acquire (or refresh) the partition lock for this device.
 *
 * @returns `"acquired"` if we now hold the lock,
 *          `"blocked"` if a live foreign holder exists (no write performed),
 *          `"lost-race"` if a higher-generation writer superseded our write
 *          inside the guard window.
 */
export async function acquirePartitionLock(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  ttlMs: number
  guardMs: number
  now?: () => number
  wait?: (ms: number) => Promise<void>
  /**
   * Pre-built generation to claim with. Pass the SAME generation already
   * advertised in a Phase-2 intent round so the winner's lock claim and its
   * intent order identically. Defaults to a fresh `(now, tiebreaker)`.
   */
  generation?: PartitionLockGeneration
  /**
   * Checked immediately before the claim write. When it returns true the
   * acquire aborts WITHOUT writing — used by `PartitionLease` to stop a
   * refresh that overlaps a `release()` from minting a ghost claim the
   * generation-fenced release would then refuse to clear (peers would have
   * to wait out the TTL).
   */
  shouldAbort?: () => boolean
}): Promise<AcquirePartitionLockResult> {
  const now = opts.now ?? Date.now
  const wait =
    opts.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const current = await readPartitionLock(opts)
  const t = now()

  // Live foreign holder — refuse without writing.
  if (
    current &&
    current.holderDeviceId !== opts.deviceId &&
    current.holderDeviceId !== NO_HOLDER_DEVICE_ID &&
    current.leasedUntil > t
  ) {
    return { outcome: "blocked", payload: current }
  }

  // The owning lease session closed while we were reading — do not write.
  if (opts.shouldAbort?.()) {
    return { outcome: "aborted", payload: current }
  }

  // Lock is empty, expired, released, or already ours. Write our claim
  // and verify after the guard window.
  const ourGeneration: PartitionLockGeneration = opts.generation ?? {
    timestampMs: t,
    tiebreaker: makeDeviceTiebreaker(opts.deviceId),
  }
  const ourPayload: PartitionLockPayload = {
    holderDeviceId: opts.deviceId,
    generation: ourGeneration,
    acquiredAt: t,
    leasedUntil: t + opts.ttlMs,
  }
  await writePartitionLock({ ...opts, payload: ourPayload })

  await wait(opts.guardMs)

  const verified = await readPartitionLock(opts)
  if (!verified) {
    // The verify-read couldn't confirm our write — e.g. the Bee node is
    // transiently 500ing on the just-written chunk, or it hasn't propagated
    // yet. We DID write our claim, and observed no live foreign holder before
    // writing (a live one returns "blocked" above), so a failed read is not
    // proof of a race. Optimistically hold; the periodic refresh reconciles
    // and demotes only on a CONFIRMED live foreign holder. Without this, a
    // read-path hiccup forces a false lost-race → read-only → slot-wait,
    // delaying activation by ~a minute even for a single device.
    return { outcome: "acquired", payload: ourPayload }
  }
  if (compareGenerations(verified.generation, ourGeneration) > 0) {
    return { outcome: "lost-race", payload: verified }
  }
  // A non-greater generation from a *different* holder still means our claim
  // stands — don't source our self-lease timestamps (acquiredAt/leasedUntil)
  // from a peer's payload.
  if (verified.holderDeviceId !== opts.deviceId) {
    return { outcome: "acquired", payload: ourPayload }
  }
  return { outcome: "acquired", payload: verified }
}

/**
 * Write the release sentinel for a SPECIFIC claim — generation-fenced.
 *
 * A release is an action on the claim identified by `releasedGeneration`,
 * not on the partition as such. The sentinel therefore carries that
 * generation (it does NOT mint a fresh one), and it is only written when the
 * lock still visibly carries the claim being released. Without the fence, a
 * detached release that outlives a re-acquire writes its sentinel LAST —
 * and Bee replaces a same-address SOC whenever the new chunk's postage
 * stamp timestamp is newer, so the stale sentinel would deterministically
 * clobber the successor's claim and peers would treat the partition as free
 * while the successor still believes it holds it (issue #349).
 *
 * Skip rules (never write a sentinel over a claim that is not the one being
 * released):
 * - an existing sentinel (any generation) — already released; rewriting
 *   would mint a fresh stamp that could clobber a claim landing in between.
 *   Checked BEFORE the generation compare: a prior sentinel for this same
 *   claim carries the same generation and would otherwise match "ours".
 * - a foreign claim, live or expired — never clobber a peer; an expired
 *   claim already reads as takeable.
 * - our own claim with a NEWER generation — a successor re-acquired while
 *   this release was publishing (#349), or a release-overlapping refresh.
 * - our own claim at a non-newer generation writes (`<=`, not `==`): a
 *   stale read returning an older refresh of the same holdership must not
 *   suppress the release.
 * - a missing/unreadable lock writes (best-effort release; the sentinel is
 *   generation-fenced, so readers and successors can order it correctly).
 *
 * Residual (documented, accepted): a skip decision is only as fresh as the
 * pre-write read. The same-device #349 race reads through the same Bee node
 * (read-your-writes holds), so the fence is dependable there; cross-node
 * staleness falls back to the displacement/TTL machinery.
 */
export async function releasePartitionLock(opts: {
  bee: Bee
  stamper: Stamper
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partition: number
  deviceId: string
  /** Generation of the claim being released — fences the sentinel. */
  releasedGeneration: PartitionLockGeneration
  /** `acquiredAt` of the claim being released (carried in the sentinel). */
  acquiredAt: number
  now?: () => number
}): Promise<ReleasePartitionLockResult> {
  const now = opts.now ?? Date.now

  const current = await readPartitionLock(opts)
  if (current) {
    const skip = (reason: string): ReleasePartitionLockResult => {
      console.info(
        `[partition-lock] Skipping release sentinel for partition ${opts.partition}: ${reason}.`,
        current,
      )
      return { outcome: "skipped", observed: current }
    }
    if (current.holderDeviceId === NO_HOLDER_DEVICE_ID) {
      return skip("already released")
    }
    if (current.holderDeviceId !== opts.deviceId) {
      return skip("a peer holds the partition")
    }
    if (compareGenerations(current.generation, opts.releasedGeneration) > 0) {
      return skip("a newer own claim exists (successor re-acquired)")
    }
  }

  const releasePayload: PartitionLockPayload = {
    holderDeviceId: NO_HOLDER_DEVICE_ID,
    generation: opts.releasedGeneration,
    acquiredAt: opts.acquiredAt,
    leasedUntil: now(),
  }
  await writePartitionLock({ ...opts, payload: releasePayload })
  return { outcome: "released", observed: current }
}
