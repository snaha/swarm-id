// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-partition lock SOC for multi-device postage-batch sharing (iteration 2).
 *
 * Replaces the per-device-claim-feed design with a single shared SOC per
 * partition. Multiple devices share the `backupSigner` so any of them can
 * write the SOC; concurrent writers are ordered deterministically by a
 * (timestampMs, tiebreaker) fencing token.
 *
 *   identifier = keccak256("swarm-id-partition-lock-v1:" || partition)
 *   owner       = backup signer (shared across the account's devices)
 *   encryption  = swarmEncryptionKey (same as iteration-1 feeds)
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
 * See: docs/Multi-Device-Partition-Lease-iteration-2.md
 */

import { Bee, PrivateKey, type Stamper } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { downloadEncryptedSOC } from "../proxy/download-data"
import { uploadSOC, type UploadTarget } from "../proxy/upload"
import { makePartitionLockIdentifier } from "../utils/lock-soc"
import { deriveSecret, deriveSwarmEncryptionKey } from "../utils/key-derivation"
import { hexToUint8Array } from "../utils/hex"

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
 * Fencing token for the partition lock. Two writers with equal `timestampMs`
 * are ordered by their per-device `tiebreaker` (hex of the first 8 bytes of
 * `keccak256(deviceId)`).
 */
export interface PartitionLockGeneration {
  /** Wall-clock ms at write time. */
  timestampMs: number
  /** Per-device fingerprint, hex. Stable across all writes by this device. */
  tiebreaker: string
}

/** Payload stored in the partition-lock SOC. ~150 bytes JSON. */
export interface PartitionLockPayload {
  holderDeviceId: string
  generation: PartitionLockGeneration
  acquiredAt: number
  leasedUntil: number
}

/**
 * Outcome of an `acquirePartitionLock` call.
 *
 * - `"acquired"` — the lock is now held by this device (write + verify both
 *   succeeded).
 * - `"blocked"` — a live foreign holder exists; no write was performed.
 * - `"lost-race"` — we wrote, but a higher-generation writer appeared
 *   during the guard window. The verify-read returned that other write.
 */
export interface AcquirePartitionLockResult {
  outcome: "acquired" | "blocked" | "lost-race"
  /** Latest payload observed by this call (after the verify-read). */
  payload: PartitionLockPayload | undefined
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
    return JSON.parse(
      new TextDecoder().decode(soc.payload),
    ) as PartitionLockPayload
  } catch {
    // Missing chunk, decryption failure, or malformed payload — treat all
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

  // Lock is empty, expired, released, or already ours. Write our claim
  // and verify after the guard window.
  const ourGeneration: PartitionLockGeneration = {
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
    // Shouldn't normally happen — we just wrote. Treat conservatively
    // as a lost race so the caller doesn't proceed under false belief.
    return { outcome: "lost-race", payload: undefined }
  }
  if (compareGenerations(verified.generation, ourGeneration) > 0) {
    return { outcome: "lost-race", payload: verified }
  }
  return { outcome: "acquired", payload: verified }
}

/** A live (unexpired, non-released) partition holder observed on Swarm. */
export interface PartitionHolder {
  partition: number
  deviceId: string
  leasedUntil: number
}

/**
 * Authoritative view of who currently holds each partition. Reads the lock
 * SOC for every partition in `[0, partitionCount)` and returns the entries
 * whose holder is live (lease unexpired, not released via the sentinel).
 *
 * Per-partition read failures are swallowed — that partition contributes
 * nothing to the result rather than failing the whole call.
 *
 * Use this when the metadata view in `activeDevices` may be stale (e.g.
 * the UI needs the "real" Active/Inactive state across peers).
 */
export async function readPartitionHolders(opts: {
  bee: Bee
  /** Same `derivationKey` stored on the account in localStorage. */
  derivationKey: string
  partitionCount: number
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}): Promise<PartitionHolder[]> {
  const now = opts.now ?? Date.now
  const swarmEncryptionKeyHex = await deriveSwarmEncryptionKey(
    opts.derivationKey,
  )
  const swarmEncryptionKey = hexToUint8Array(swarmEncryptionKeyHex)
  const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
  const backupSigner = new PrivateKey(backupKeyHex)

  const partitions = Array.from({ length: opts.partitionCount }, (_, p) => p)
  const reads = await Promise.all(
    partitions.map(async (partition) => {
      try {
        const payload = await readPartitionLock({
          bee: opts.bee,
          backupSigner,
          swarmEncryptionKey,
          partition,
        })
        return { partition, payload }
      } catch {
        return { partition, payload: undefined }
      }
    }),
  )

  const t = now()
  const holders: PartitionHolder[] = []
  for (const { partition, payload } of reads) {
    if (!payload) continue
    if (payload.holderDeviceId === NO_HOLDER_DEVICE_ID) continue
    if (payload.leasedUntil <= t) continue
    holders.push({
      partition,
      deviceId: payload.holderDeviceId,
      leasedUntil: payload.leasedUntil,
    })
  }
  return holders
}
