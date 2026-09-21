// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Web Worker pool for parallel stamp signing.
 *
 * Architecture:
 * - Main thread: slot assignment (fast, stateful, sequential)
 * - Workers: ECDSA signing (slow, stateless, parallel)
 *
 * The pool only signs. The slot comes from the stamper it was created for — a
 * `SlotAssigner`'s `assignSlot()`, or a plain core-sdk `Stamper`'s `buckets` —
 * so a pooled stamp lands where `stamper.stamp()` would have put it.
 */

import type { Stamper, EnvelopeWithBatchId, BatchId } from "@ethersphere/bee-js"
import { EthAddress, Signature } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import type { SlotAssigner } from "../utils/batch-utilization"
import type {
  StampWorkerReadyResponse,
  StampWorkerSignedResponse,
} from "./stamp-worker-handler"

// Imported at build time via virtual module (see rollup.config.js)
import stampWorkerCode from "virtual:stamp-worker-code"

interface PendingSign {
  resolve: (signatureHex: string) => void
  reject: (error: Error) => void
}

interface WorkerHandle {
  worker: Worker
  pending: Map<number, PendingSign>
}

const DEFAULT_WORKER_COUNT = 4
const WORKER_INIT_TIMEOUT_MS = 5_000
const NANOSECONDS_PER_MILLISECOND = 1_000_000n
const POOL_TERMINATED_MESSAGE = "Stamp worker pool is terminated"

/** core-sdk's `Stamper#stamp` slot bookkeeping, read off the live `buckets`. */
function nextBucketSlot(stamper: Stamper, address: Uint8Array): number {
  const bucket = (address[0] << 8) | address[1]
  const height = stamper.buckets[bucket]
  if (height >= stamper.maxSlot) {
    throw new Error("Bucket is full")
  }
  stamper.buckets[bucket] = height + 1
  return height
}

export class StampWorkerPool {
  private workers: WorkerHandle[]
  private nextWorker = 0
  private nextId = 0
  private issuer: Uint8Array // 20 bytes
  private batchId: BatchId
  private assignSlot: (address: Uint8Array) => number

  readonly size: number
  /** The stamper this pool signs for: a pool must not outlive it. */
  readonly stamper: Stamper | SlotAssigner

  private constructor(
    workers: WorkerHandle[],
    issuer: Uint8Array,
    stamper: Stamper | SlotAssigner,
  ) {
    this.workers = workers
    this.size = workers.length
    this.issuer = issuer
    this.stamper = stamper
    this.batchId = stamper.batchId
    this.assignSlot =
      "assignSlot" in stamper
        ? (address) => stamper.assignSlot(address)
        : (address) => nextBucketSlot(stamper, address)
  }

  /**
   * Create a worker pool from an existing stamper.
   *
   * @param signerKeyHex - Signer private key as hex (proxy already has this)
   * @param stamper - Stamper the pool signs for; it stays the slot owner
   * @param workerCount - Number of workers (defaults to 4)
   */
  static async create(
    signerKeyHex: string,
    stamper: Stamper | SlotAssigner,
    workerCount?: number,
  ): Promise<StampWorkerPool> {
    const count = workerCount ?? DEFAULT_WORKER_COUNT

    // Create workers from inline Blob URL
    const blob = new Blob([stampWorkerCode], { type: "application/javascript" })
    const workerUrl = URL.createObjectURL(blob)

    const handles: WorkerHandle[] = []
    const initPromises: Promise<Uint8Array>[] = []

    for (let i = 0; i < count; i++) {
      const worker = new Worker(workerUrl, { type: "classic" })
      const handle: WorkerHandle = { worker, pending: new Map() }

      worker.onmessage = (
        event: MessageEvent<
          StampWorkerReadyResponse | StampWorkerSignedResponse
        >,
      ) => {
        const msg = event.data
        if (msg.type === "signed") {
          const p = handle.pending.get(msg.id)
          if (p) {
            handle.pending.delete(msg.id)
            p.resolve(msg.signatureHex)
          }
        }
      }

      worker.onerror = (event) => {
        // Reject all pending for this worker
        for (const [, p] of handle.pending) {
          p.reject(new Error(`Stamp worker error: ${event.message}`))
        }
        handle.pending.clear()
      }

      handles.push(handle)

      // Init worker with private key, collect issuer from ready response
      const initPromise = new Promise<Uint8Array>((resolve, reject) => {
        const origHandler = worker.onmessage
        const origErrorHandler = worker.onerror
        const timer = setTimeout(() => {
          reject(new Error("Stamp worker init timed out"))
        }, WORKER_INIT_TIMEOUT_MS)
        worker.onmessage = (
          event: MessageEvent<
            StampWorkerReadyResponse | StampWorkerSignedResponse
          >,
        ) => {
          if (event.data.type === "ready") {
            clearTimeout(timer)
            worker.onmessage = origHandler
            worker.onerror = origErrorHandler
            resolve(
              Binary.hexToUint8Array(
                (event.data as StampWorkerReadyResponse).issuerHex,
              ),
            )
          }
        }
        worker.onerror = () => {
          clearTimeout(timer)
          reject(new Error("Worker init failed"))
        }
        worker.postMessage({ type: "init", signerKeyHex })
      })

      initPromises.push(initPromise)
    }

    // Wait for all workers to initialize
    const issuers = await Promise.all(initPromises)
    const issuer = issuers[0]

    // Revoke Blob URL (workers already loaded)
    URL.revokeObjectURL(workerUrl)

    return new StampWorkerPool(handles, issuer, stamper)
  }

  /**
   * Stamp a chunk address using parallel worker signing.
   *
   * Slot assignment happens on the main thread, before the first await, so
   * concurrent calls cannot interleave inside it. ECDSA signing is dispatched
   * to a worker (slow, parallel).
   *
   * Takes the same `timestampMs` as core-sdk's `Stamper.stamp`, and produces
   * the same envelope for the same inputs — `stamp-worker-pool.test.ts` holds
   * the two to that, field by field.
   */
  async stampChunkData(
    address: Uint8Array,
    timestampMs: number = Date.now(),
  ): Promise<EnvelopeWithBatchId> {
    // Checked before a slot is spent on a stamp nothing will sign
    if (this.workers.length === 0) {
      throw new Error(POOL_TERMINATED_MESSAGE)
    }

    // 1. Slot assignment (main thread) — the stamper's, never the pool's own
    const bucket = (address[0] << 8) | address[1]
    const slot = this.assignSlot(address)

    // Build index (8 bytes): bucket(4 BE) + slot(4 BE)
    const index = new Uint8Array(8)
    const indexView = new DataView(index.buffer)
    indexView.setUint32(0, bucket, false)
    indexView.setUint32(4, slot, false)

    // Build timestamp (8 bytes): uint64 BE in nanoseconds — the unit Bee and
    // core-sdk's `Stamper` use, and what Bee compares on an index collision
    const timestamp = new Uint8Array(8)
    const tsView = new DataView(timestamp.buffer)
    tsView.setBigUint64(
      0,
      BigInt(timestampMs) * NANOSECONDS_PER_MILLISECOND,
      false,
    )

    // 2. Construct signing message (80 bytes)
    const message = Binary.concatBytes(
      address,
      this.batchId.toUint8Array(),
      index,
      timestamp,
    )

    // 3. Dispatch signing to worker (round-robin)
    const signatureHex = await this.dispatchSign(message)
    const signature = Binary.hexToUint8Array(signatureHex)

    // 4. Return envelope
    return {
      batchId: this.batchId,
      index,
      issuer: new EthAddress(this.issuer),
      signature: new Signature(signature),
      timestamp,
    }
  }

  private dispatchSign(message: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const handle = this.workers[this.nextWorker++ % this.workers.length]
      handle.pending.set(id, { resolve, reject })
      handle.worker.postMessage({ type: "sign", id, message })
    })
  }

  /**
   * Terminate all workers and release resources. Signs still in flight are
   * rejected: a terminated worker never answers, and an upload awaiting one
   * would hang.
   */
  terminate(): void {
    for (const handle of this.workers) {
      handle.worker.terminate()
      for (const [, p] of handle.pending) {
        p.reject(new Error(POOL_TERMINATED_MESSAGE))
      }
      handle.pending.clear()
    }
    this.workers = []
  }
}
