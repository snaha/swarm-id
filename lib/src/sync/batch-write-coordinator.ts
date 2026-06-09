// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `BatchWriteCoordinator` — the write path for one account+batch.
 *
 * Owns everything needed to **write to a shared postage batch as a partition
 * holder**, and nothing about client communication:
 *   - the cross-tab Web Lock (`withBatchWriteLock`),
 *   - the partition-lease lifecycle (acquire / refresh / yield / demote),
 *   - stamper-state flush under the lock.
 *
 * Two consumers share it:
 *   - the proxy iframe — long-lived (`mode: "persistent"`): eager
 *     `startLease()` + a refresh timer; an upload that can't get a partition
 *     blocks for a slot and then throws.
 *   - `sync-account` — one-off (`mode: "oneshot"`): no refresh timer; a write
 *     claims a free/expired partition once and throws `PartitionContendedError`
 *     when every partition is held by a live foreign device, so the caller
 *     skips. The lease then lapses by TTL.
 *
 * The lock SOC on Swarm (`partition-lock.ts`) stays the cross-device authority;
 * this class is the lifecycle layer above `PartitionLease`. See
 * `docs/BatchWriteCoordinator-Implementation-Plan.md`.
 *
 * NOTE (migration): this file is being filled in phased — issue #336 steps
 * A→D. Step A introduces the module boundary (error type, the pure
 * `isDisplaced` helper, the deps interface, and the class shell). The lease
 * cluster (Step B) and `withWrite` (Step C) land next; the proxy does not
 * delegate to it yet.
 */

import { Bee, PrivateKey } from "@ethersphere/bee-js"
import { UtilizationAwareStamper } from "../utils/batch-utilization"
import { PartitionLease } from "./partition-lease"
import type { PartitionLeaseStateSnapshot } from "./partition-lease"
import { NO_HOLDER_DEVICE_ID } from "./partition-lock"

/**
 * Thrown by `withWrite` in `wait: "skip"` mode when every partition is held by
 * a live foreign device, i.e. there is genuinely no slot to claim. The caller
 * (`sync-account`) catches this and skips the publish — distinct from an
 * operational error (missing stamper, a lock-SOC write that threw), which
 * propagates so it can be logged as an error rather than as contention.
 */
export class PartitionContendedError extends Error {
  constructor(
    message = "All partitions are held by other devices.",
    readonly accountId?: string,
  ) {
    super(message)
    this.name = "PartitionContendedError"
  }
}

/**
 * A lock-SOC payload means this device has been displaced only if it names a
 * *different*, *live* device. A missing/unreadable payload (e.g. a Bee 500),
 * our own id, the release sentinel, or an *expired* foreign holder are all NOT
 * displacement — the holder keeps its lease and retries. Pure (no instance
 * state) so it can be unit-tested directly; mirrors the proxy's former
 * `isDisplaced`.
 */
export function isDisplaced(
  payload: { holderDeviceId: string; leasedUntil: number } | undefined,
  now: number,
  selfDeviceId: string,
): boolean {
  return (
    payload !== undefined &&
    payload.holderDeviceId !== selfDeviceId &&
    payload.holderDeviceId !== NO_HOLDER_DEVICE_ID &&
    payload.leasedUntil > now
  )
}

/** Long-lived (proxy) vs one-off (`sync-account`) lease behaviour. */
export type CoordinatorMode = "persistent" | "oneshot"

/** Per-transition lease snapshot handed to `onLeaseChange`. */
export interface LeaseChangeInfo {
  currentPartition: number | undefined
  isReadOnly: boolean
}

export interface BatchWriteCoordinatorDeps {
  bee: Bee
  /** Postage batch id (hex) — the `withBatchWriteLock` key. */
  batchId: string
  /** Already created + account-bound by the caller; the coordinator only
   *  binds/unbinds the held partition on it. */
  stamper: UtilizationAwareStamper
  /** This device's identity, captured once by the caller. */
  deviceId: string
  accountId: string
  /** Owns the per-partition lock SOCs (derived from the account key). */
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  partitionCount: number
  mode: CoordinatorMode
  /** Persistent mode only: read/write the local lease-cache hint. */
  readLeaseCache?: () => PartitionLeaseStateSnapshot | undefined
  writeLeaseCache?: (snap: PartitionLeaseStateSnapshot | undefined) => void
  /** Flush stamper bucket state after a write (proxy: `saveStamperState`). */
  flushStamperState?: () => Promise<void>
  /** Fired on every partition / read-only transition. */
  onLeaseChange?: (info: LeaseChangeInfo) => void
  /** Fired once when a partition is first acquired (phase-5 publish trigger). */
  onLeaseAcquired?: (partition: number) => void
}

export class BatchWriteCoordinator {
  private readonly deps: BatchWriteCoordinatorDeps

  /** Active partition-lease; undefined when no lease is held (read-only mode,
   *  or single-partition legacy accounts). */
  private partitionLease: PartitionLease | undefined
  private partitionRefreshTimer: ReturnType<typeof setInterval> | undefined
  private readOnly: boolean = false

  constructor(deps: BatchWriteCoordinatorDeps) {
    this.deps = deps
  }

  /** Current held partition, or undefined (read-only / legacy / not yet acquired). */
  get currentPartition(): number | undefined {
    return this.partitionLease?.currentPartition
  }

  /** True when every partition is held by a live peer and this device cannot write. */
  get isReadOnly(): boolean {
    return this.readOnly
  }

  /** The bound stamper — exposed for the proxy's `buildConnectionInfo`
   *  (appKey / uploadMode). */
  get stamperRef(): UtilizationAwareStamper {
    return this.deps.stamper
  }

  /**
   * Tear down all lease background work and drop the in-memory lease. Used on
   * sign-out / disconnect. Best-effort; never throws. The full
   * release-the-partition behaviour (publish the final counter, write the
   * release sentinel) lands in Step B; for now this stops the timer and clears
   * in-memory state so the instance can be discarded safely.
   */
  teardown(): void {
    if (this.partitionRefreshTimer !== undefined) {
      clearInterval(this.partitionRefreshTimer)
      this.partitionRefreshTimer = undefined
    }
    this.partitionLease = undefined
    this.readOnly = false
    this.deps.writeLeaseCache?.(undefined)
    this.emitLeaseChange()
  }

  /** Notify the consumer of the current lease state (idempotent on the
   *  consumer side — the proxy suppresses unchanged ConnectionInfo). */
  private emitLeaseChange(): void {
    this.deps.onLeaseChange?.({
      currentPartition: this.currentPartition,
      isReadOnly: this.readOnly,
    })
  }

  // ---- filled in subsequent migration steps -------------------------------
  // Step B: acquirePartitionLease / ensureLease / slot-wait / refreshTick /
  //         yieldIdleLease / demote (with the invalidate-without-unbind race
  //         fix) / release / captureLeaseContext, plus startLease().
  // Step C: withWrite() — the locked write entry point + stamper flush.
}
