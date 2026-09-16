// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Web Worker entry point for parallel ECDSA stamp signing.
 *
 * The worker receives stamp messages (address + batchId + index + timestamp)
 * and returns secp256k1 ECDSA signatures. The bucket assignment (stateful, fast)
 * stays on the main thread; only the signing (stateless, slow ~4ms) runs here.
 *
 * The protocol and the handler live in `stamp-worker-handler.ts`; this file
 * only binds the handler to the Worker global, so it must never be imported
 * from the main thread — rollup bundles it into `dist/stamp-worker.iife.js`.
 */

import {
  handleMessage,
  type StampWorkerMessage,
  type StampWorkerResponse,
} from "./stamp-worker-handler"

interface WorkerGlobalScopeMinimal {
  onmessage: ((event: MessageEvent<StampWorkerMessage>) => void) | undefined
  postMessage(message: StampWorkerResponse): void
}

const workerSelf = self as unknown as WorkerGlobalScopeMinimal

workerSelf.onmessage = (event: MessageEvent<StampWorkerMessage>) => {
  workerSelf.postMessage(handleMessage(event.data))
}
