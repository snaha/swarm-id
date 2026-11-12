// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SwarmIdError } from "../errors"
import { STREAM_PIECE_SIZE } from "../proxy/chunking"
import type { UploadInput } from "../types"

/**
 * An upload's bytes, read one bounded piece at a time. Each piece owns its
 * buffer, so it can be transferred across the iframe bridge: a posted view
 * would clone the whole buffer under it.
 */
export interface PieceSource {
  /** The total in bytes, when the input knows it */
  readonly size: number | undefined
  /** The next piece, or undefined at the end */
  next: () => Promise<Uint8Array | undefined>
  cancel: (reason?: unknown) => Promise<void>
}

function isStream(input: UploadInput): input is ReadableStream<Uint8Array> {
  return typeof (input as ReadableStream).getReader === "function"
}

function isBlob(input: UploadInput): input is Blob {
  return typeof (input as Blob).arrayBuffer === "function"
}

/** Sliced by hand: Safari's `Blob.stream()` yields a blob as one piece. */
function blobSource(blob: Blob): PieceSource {
  let offset = 0
  return {
    size: blob.size,
    next: async () => {
      if (offset >= blob.size) return undefined
      const end = Math.min(offset + STREAM_PIECE_SIZE, blob.size)
      const piece = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
      offset = end
      return piece
    },
    cancel: async () => {},
  }
}

function streamSource(stream: ReadableStream<Uint8Array>): PieceSource {
  if (stream.locked) {
    throw new SwarmIdError(
      "invalid-request",
      "The upload stream is locked: another reader holds it.",
    )
  }
  const reader = stream.getReader()
  let rest: Uint8Array | undefined
  return {
    size: undefined,
    next: async () => {
      while (!rest?.length) {
        const { done, value } = await reader.read()
        if (done) return undefined
        if (!(value instanceof Uint8Array)) {
          throw new SwarmIdError(
            "invalid-request",
            "An upload stream must yield Uint8Array chunks.",
          )
        }
        rest = value
      }
      const piece = rest.slice(0, STREAM_PIECE_SIZE)
      rest = rest.subarray(STREAM_PIECE_SIZE)
      return piece
    },
    cancel: (reason) => reader.cancel(reason),
  }
}

/** A source for a `Blob` or `ReadableStream`; undefined for plain bytes. */
export function openPieceSource(input: UploadInput): PieceSource | undefined {
  if (isStream(input)) return streamSource(input)
  if (isBlob(input)) return blobSource(input)
  return undefined
}
