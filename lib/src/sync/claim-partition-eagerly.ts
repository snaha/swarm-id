// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Eager partition claim — used during sign-in (and by the proxy's cold path)
 * to scan partitions and acquire a free / expired one without waiting for
 * the first upload. Hides claim latency under the sign-in UX so the user's
 * first upload doesn't pay the full TTL on a third device joining.
 */

import { BatchId, type Bee, PrivateKey } from "@ethersphere/bee-js"
import {
  LEASE_REFRESH_MS,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import { deriveSecret, deriveSwarmEncryptionKey } from "../utils/key-derivation"
import { hexToUint8Array } from "../utils/hex"
import type { ActiveDevice } from "../schemas"
import { PartitionLease } from "./partition-lease"

/** Default timeout for the claim wait loop — matches the wait-for-slot SLA. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 30 * 1000

export interface ClaimPartitionResult {
  /** Acquired partition, or `undefined` if the loop timed out / was aborted. */
  partition: number | undefined
  /**
   * `activeDevices` to mirror back into the account snapshot. On success
   * includes this device's new entry; on failure echoes the input.
   */
  activeDevices: ActiveDevice[]
}

export interface ClaimPartitionEagerlyOpts {
  bee: Bee
  /**
   * Stamper for the batch this claim targets. `UtilizationAwareStamper.create`
   * already auto-binds the lock-SOC routing from `(partition, owner)`, so the
   * stamper does NOT need to be partition-bound — callers may pass a freshly-
   * created stamper that has never held a lease.
   */
  stamper: UtilizationAwareStamper
  /** Account derivation key, same value held in the account store. */
  derivationKey: string
  batchId: BatchId
  batchDepth: number
  activeDevices: ActiveDevice[]
  partitionCount: number
  deviceId: string
  /** Abort signal — if fired, the helper returns immediately. */
  abortSignal?: AbortSignal
  /** Maximum wall-clock time to wait for a slot. Default 30 s. */
  timeoutMs?: number
  /** Poll cadence while waiting for a slot. Default `LEASE_REFRESH_MS`. */
  pollIntervalMs?: number
}

/**
 * Try to acquire a partition lease. Scans all partitions; if every one is
 * held by a live foreign holder, polls until a slot opens up or the timeout
 * elapses.
 *
 * Returns `{ partition: undefined }` on timeout / abort. Callers should fall
 * back to read-only mode (or surface a "no partition available" error to the
 * user) in that case.
 */
export async function claimPartitionEagerly(
  opts: ClaimPartitionEagerlyOpts,
): Promise<ClaimPartitionResult> {
  const swarmEncryptionKey = await deriveSwarmEncryptionKey(opts.derivationKey)
  const swarmEncryptionKeyBytes = hexToUint8Array(swarmEncryptionKey)
  const backupKeyHex = await deriveSecret(swarmEncryptionKey, "backup-key")
  const backupSigner = new PrivateKey(backupKeyHex)

  // Lock-SOC routing on the stamper is auto-bound by
  // `UtilizationAwareStamper.create` from (partition, owner); nothing to
  // wire here.

  const lease = new PartitionLease({
    bee: opts.bee,
    deviceId: opts.deviceId,
    batchId: opts.batchId,
    batchDepth: opts.batchDepth,
    swarmEncryptionKey: swarmEncryptionKeyBytes,
    backupSigner,
    stamper: opts.stamper,
  })

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? LEASE_REFRESH_MS
  const deadline = Date.now() + timeoutMs
  let currentActiveDevices = opts.activeDevices

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.abortSignal?.aborted) {
      return { partition: undefined, activeDevices: currentActiveDevices }
    }

    const result = await lease.acquire({
      activeDevices: currentActiveDevices,
      partitionCount: opts.partitionCount,
    })

    if (result.partition !== undefined) {
      return {
        partition: result.partition,
        activeDevices: result.activeDevices,
      }
    }

    // All partitions live + foreign-held. Track the latest snapshot of
    // activeDevices we saw so retries don't re-add the same device twice.
    currentActiveDevices = result.activeDevices

    if (Date.now() + pollIntervalMs > deadline) {
      return { partition: undefined, activeDevices: currentActiveDevices }
    }

    await sleepWithAbort(pollIntervalMs, opts.abortSignal)
  }
}

function sleepWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort)
  })
}
