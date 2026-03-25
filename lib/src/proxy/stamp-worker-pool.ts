/**
 * Web Worker pool for parallel stamp signing.
 *
 * Architecture:
 * - Main thread: bucket assignment (fast, stateful, sequential)
 * - Workers: ECDSA signing (slow ~4ms, stateless, parallel)
 *
 * The pool wraps an existing Stamper's bucket state (same Uint32Array reference)
 * so bucket counters stay synchronized.
 */

import type { Stamper, EnvelopeWithBatchId, BatchId } from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import type {
  StampWorkerReadyResponse,
  StampWorkerSignedResponse,
} from "./stamp-worker"

// Imported at build time via virtual module (see rollup.config.js)
// eslint-disable-next-line @typescript-eslint/no-require-imports
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

export class StampWorkerPool {
  private workers: WorkerHandle[]
  private nextWorker = 0
  private nextId = 0
  private issuer: Uint8Array // 20 bytes
  private buckets: Uint32Array // ref to stamper.buckets
  private batchId: BatchId
  private maxSlot: number

  readonly size: number

  private constructor(
    workers: WorkerHandle[],
    issuer: Uint8Array,
    stamper: Stamper,
  ) {
    this.workers = workers
    this.size = workers.length
    this.issuer = issuer
    this.buckets = stamper.buckets
    this.batchId = stamper.batchId
    this.maxSlot = stamper.maxSlot
  }

  /**
   * Create a worker pool from an existing stamper.
   *
   * @param signerKeyHex - Signer private key as hex (proxy already has this)
   * @param stamper - Stamper instance (pool shares its bucket state)
   * @param workerCount - Number of workers (defaults to 4)
   */
  static async create(
    signerKeyHex: string,
    stamper: Stamper,
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
        worker.onmessage = (
          event: MessageEvent<
            StampWorkerReadyResponse | StampWorkerSignedResponse
          >,
        ) => {
          if (event.data.type === "ready") {
            worker.onmessage = origHandler
            resolve(
              Binary.hexToUint8Array(
                (event.data as StampWorkerReadyResponse).issuerHex,
              ),
            )
          }
        }
        worker.onerror = () => reject(new Error("Worker init failed"))
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
   * Stamp chunk data using parallel worker signing.
   *
   * Bucket assignment happens on the main thread (fast, sequential).
   * ECDSA signing is dispatched to a worker (slow, parallel).
   */
  async stampChunkData(
    _chunkData: Uint8Array,
    address: Uint8Array,
  ): Promise<EnvelopeWithBatchId> {
    // 1. Bucket assignment (main thread) — replicates Stamper.stamp() logic
    const bucket = (address[0] << 8) | address[1]
    const height = this.buckets[bucket]
    if (height >= this.maxSlot) {
      throw new Error("Bucket is full")
    }
    this.buckets[bucket] = height + 1

    // Build index (8 bytes): bucket(4 BE) + height(4 BE)
    const index = new Uint8Array(8)
    const indexView = new DataView(index.buffer)
    indexView.setUint32(0, bucket, false)
    indexView.setUint32(4, height, false)

    // Build timestamp (8 bytes): uint64 BE of Date.now()
    const timestamp = new Uint8Array(8)
    const tsView = new DataView(timestamp.buffer)
    const now = BigInt(Date.now())
    tsView.setBigUint64(0, now, false)

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
      issuer: this.issuer,
      signature,
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
   * Terminate all workers and release resources.
   */
  terminate(): void {
    for (const handle of this.workers) {
      handle.worker.terminate()
    }
    this.workers = []
  }
}
