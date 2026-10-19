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
 * One drive's write path in a proxy session: the stamp the session resolved,
 * and the stamper, coordinator and worker pool built from it.
 *
 * Everything here belongs to that one batch, so it is created when the stamp
 * resolves and dropped as a unit when it changes: the stamper, the account it
 * was built for and the coordinator that writes through it arrive together
 * (`attach`), and the proxy never sets one of them alone. That is also how a
 * stale `initializeStamper` knows it has been superseded: the proxy holds a
 * different instance (#862).
 */
export class DriveWritePath {
  private _stamper: UtilizationAwareStamper | undefined
  private _accountFingerprint: string | undefined
  private _coordinator: BatchWriteCoordinator | undefined
  private workerPool: StampWorkerPool | undefined

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

  /**
   * Attached by `SwarmIdProxy.initializeStamper` once it builds one. Undefined
   * before that, and for good when that init gave up: it logs and returns
   * rather than throwing, so a resolved stamp with no stamper is a state the
   * proxy really reaches.
   */
  get stamper(): UtilizationAwareStamper | undefined {
    return this._stamper
  }

  /**
   * `<owner>-<encryptionKey>` the `stamper` was built with. Account-level
   * inputs are baked into `UtilizationAwareStamper` at construction, so when
   * the underlying account changes (e.g. a local account migrates to a synced
   * one) the proxy detects that even if the stamp's batch/signer didn't
   * change, and rebuilds the stamper.
   */
  get accountFingerprint(): string | undefined {
    return this._accountFingerprint
  }

  /**
   * The write path (lock + partition lease + stamp flush) for this
   * account+batch. Undefined before `attach`, and again after `teardown`.
   */
  get coordinator(): BatchWriteCoordinator | undefined {
    return this._coordinator
  }

  /**
   * The stamper and the coordinator that writes through it, in one step: a
   * stamper without its coordinator tells an upload it is in user-stamp mode
   * and then has nothing to write through, so there is no way to set one
   * without the other.
   */
  attach(
    stamper: UtilizationAwareStamper,
    accountFingerprint: string,
    coordinator: BatchWriteCoordinator,
  ): void {
    this._stamper = stamper
    this._accountFingerprint = accountFingerprint
    this._coordinator = coordinator
  }

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
   * coordinator's `onLeaseReleased` on the way out. The stamper stays: the
   * proxy drops the whole path right after, or is being destroyed.
   */
  teardown(): void {
    this._coordinator?.teardown()
    this._coordinator = undefined
    this.terminateWorkerPool()
  }

  private terminateWorkerPool(): void {
    this.workerPool?.terminate()
    this.workerPool = undefined
  }
}
