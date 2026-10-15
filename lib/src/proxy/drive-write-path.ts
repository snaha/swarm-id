// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BatchWriteCoordinator } from "../sync/batch-write-coordinator"
import type { UtilizationAwareStamper } from "../utils/batch-utilization"
import {
  stampRefusal,
  type StampLifetimeFields,
  type StampRefusal,
} from "../utils/stamp-lifespan"
import { StampWorkerPool } from "./stamp-worker-pool"

const DEFAULT_WORKER_COUNT = 4
const MAX_WORKER_COUNT = 8

/**
 * One drive's write path in a proxy session: a granted stamp, and the
 * stamper, coordinator and worker pool built from it. The proxy holds one per
 * drive it writes to, keyed by batch; they never reference each other (#862).
 *
 * Everything here belongs to that one batch, so it is created as a unit and
 * dropped as a unit when its stamp changes or leaves the grant — the proxy
 * never patches one field of it. That is also how a stale `initializeStamper`
 * knows it has been superseded: the proxy holds a different instance.
 */
export class DriveWritePath {
  /**
   * Set by `SwarmIdProxy.initializeStamper` once it builds one. Undefined
   * before that, and for good when that init gave up: it logs and returns
   * rather than throwing, so a resolved stamp with no stamper is a state the
   * proxy really reaches.
   */
  stamper: UtilizationAwareStamper | undefined
  /**
   * Hash of `<owner>-<encryptionKey>` the `stamper` was built with.
   * Account-level inputs are baked into `UtilizationAwareStamper` at
   * construction, so when the underlying account changes (e.g. a local
   * account migrates to a synced one) we need to detect that even if the
   * postage stamp's batch/signer didn't change, and rebuild the stamper.
   */
  accountFingerprint: string | undefined
  /**
   * The write path (lock + partition lease + stamp flush) for this
   * account+batch, assigned together with the `stamper` it writes through.
   */
  coordinator: BatchWriteCoordinator | undefined
  /** Settles when `initializeStamper` for this drive is done, either way. */
  ready: Promise<void> = Promise.resolve()
  private workerPool: StampWorkerPool | undefined
  private tornDown = false

  constructor(
    readonly batchId: string,
    readonly signerKey: string,
    /**
     * The stamp's stored lifetime fields (#745). Expiry is derived from them
     * on every read, so a tab left open past the drive's lifetime refuses its
     * own writes rather than letting Bee refuse the lease claim.
     */
    readonly lifetime: StampLifetimeFields,
  ) {}

  /** Why the session refuses to stamp with this drive, if it does. */
  get refusal(): StampRefusal | undefined {
    return stampRefusal(this.lifetime)
  }

  /**
   * Get or create a StampWorkerPool for parallel signing.
   * Lazy-initialized on first use and reused across uploads, for as long as
   * it signs for this drive's stamper and has the requested size.
   */
  async getOrCreateWorkerPool(
    requestedCount?: number,
  ): Promise<StampWorkerPool | undefined> {
    const desiredCount =
      requestedCount ??
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? Math.min(navigator.hardwareConcurrency, MAX_WORKER_COUNT)
        : DEFAULT_WORKER_COUNT)

    // A coordinator torn down mid-write still asks; a pool built for it now
    // would never be terminated. It signs on the main thread instead.
    if (this.tornDown) return undefined

    if (
      this.workerPool?.size === desiredCount &&
      this.workerPool.stamper === this.stamper
    ) {
      return this.workerPool
    }

    this.terminateWorkerPool()

    if (!this.stamper) return undefined

    try {
      this.workerPool = await StampWorkerPool.create(
        this.signerKey,
        this.stamper,
        desiredCount,
      )
      return this.workerPool
    } catch (error) {
      console.warn("[Proxy] Failed to create StampWorkerPool:", error)
      return undefined
    }
  }

  /**
   * Tear the coordinator down, and the pool with it: the pool signs for the
   * stamper this coordinator wrote through, and its workers hold that
   * stamper's signer key. A held partition is announced through the
   * coordinator's `onLeaseReleased` on the way out.
   */
  teardown(): void {
    this.tornDown = true
    this.coordinator?.teardown()
    this.coordinator = undefined
    this.terminateWorkerPool()
  }

  private terminateWorkerPool(): void {
    this.workerPool?.terminate()
    this.workerPool = undefined
  }
}
