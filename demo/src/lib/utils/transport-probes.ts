// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The two transport probes of the Safari check (#979), run in the browser
 * that loads the page. Neither needs a connection: they ask the engine, not
 * the identity iframe. `safari-check.ts` says what their answers mean.
 */
import { TimeoutError, withTimeout } from '@snaha/swarm-id'

import {
  BLOB_PROBE_BYTES,
  type BlobStreamObservation,
  STREAM_ARRIVAL_TIMEOUT_MS,
  type StreamTransferObservation,
} from './safari-check'

const PROBE_PAYLOAD = 'swarm-id transport probe'

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

/** Post a `ReadableStream` as a transferable over a `MessageChannel`, and read what arrives. */
export async function probeStreamTransfer(): Promise<StreamTransferObservation> {
  const sent = new TextEncoder().encode(PROBE_PAYLOAD)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sent.slice())
      controller.close()
    },
  })
  const channel = new MessageChannel()
  const arrival = new Promise<unknown>((resolve) => {
    channel.port2.onmessage = (event) => resolve(event.data)
  })
  try {
    try {
      channel.port1.postMessage(stream, [stream])
    } catch (error) {
      return {
        outcome: 'threw',
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    let received: unknown
    try {
      received = await withTimeout(
        arrival,
        STREAM_ARRIVAL_TIMEOUT_MS,
        'The transferred stream did not arrive',
      )
    } catch (error) {
      if (error instanceof TimeoutError) return { outcome: 'lost' }
      throw error
    }
    if (!(received instanceof ReadableStream)) return { outcome: 'arrived', intact: false }
    try {
      const back = new Uint8Array(await new Response(received).arrayBuffer())
      return { outcome: 'arrived', intact: sameBytes(back, sent) }
    } catch {
      return { outcome: 'arrived', intact: false }
    }
  } finally {
    channel.port1.close()
    channel.port2.close()
  }
}

/** Read a zero-filled blob through `Blob.stream()`, counting the pieces it hands back. */
export async function probeBlobStream(): Promise<BlobStreamObservation> {
  const blob = new Blob([new Uint8Array(BLOB_PROBE_BYTES)])
  // A reader rather than `for await`: async iteration of a ReadableStream is not on every engine.
  const reader = blob.stream().getReader()
  let pieces = 0
  let largestPiece = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pieces++
    largestPiece = Math.max(largestPiece, value.byteLength)
  }
  return { size: blob.size, pieces, largestPiece }
}
