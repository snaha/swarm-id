// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Which path a transfer took across the identity iframe, read off the bridge
 * itself. The dApp window receives every message the proxy iframe posts, so a
 * listener beside the client's sees the proxy pull an upload's pieces
 * (`uploadSourcePull`) and hand a download's over (`downloadStreamPiece`). No
 * pulls means the bytes went over in one message.
 *
 * The counts cover every transfer in flight while one is watched: the
 * messages carry the client's request id, which the demo never sees.
 */

/** Asks the dApp for one more piece of an upload */
const UPLOAD_PULL = 'uploadSourcePull'
/** One piece of a streaming download; no `data` is the end marker */
const DOWNLOAD_PIECE = 'downloadStreamPiece'

export interface BridgeTally {
  /** `uploadSourcePull`s seen */
  pulls: number
  /** The sources pulled from, one per file: each one's last pull is answered with the end marker */
  sources: Set<string>
  /** `downloadStreamPiece`s that carried bytes */
  downloadPieces: number
  /** `downloadStreamPiece`s with none: a streamed download's end, even an empty one's */
  downloadEnds: number
}

export function emptyTally(): BridgeTally {
  return { pulls: 0, sources: new Set(), downloadPieces: 0, downloadEnds: 0 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && !!value
}

/** Count one message the proxy posted; anything else leaves the tally as it is. */
export function tallyMessage(tally: BridgeTally, data: unknown): void {
  if (!isRecord(data)) return
  if (data.type === UPLOAD_PULL) {
    tally.pulls++
    tally.sources.add(`${String(data.requestId)}:${String(data.index ?? '')}`)
  } else if (data.type === DOWNLOAD_PIECE) {
    if (data.data === undefined) tally.downloadEnds++
    else tally.downloadPieces++
  }
}

function pieces(count: number): string {
  return count === 1 ? '1 piece' : `${count} pieces`
}

/** The upload's path, as the demo logs it. */
export function describeUpload(tally: BridgeTally): string {
  if (tally.pulls === 0) return 'Upload path: buffered — sent in one message'
  // Every source's last pull is answered with the end marker, not a piece.
  const pulled = tally.pulls - tally.sources.size
  const files = tally.sources.size > 1 ? `, from ${tally.sources.size} files` : ''
  return `Upload path: streamed — ${pieces(pulled)} pulled across the iframe${files}`
}

/** The download's path, as the demo logs it. */
export function describeDownload(tally: BridgeTally): string {
  if (tally.downloadPieces === 0 && tally.downloadEnds === 0) {
    return 'Download path: buffered — received in one message'
  }
  return `Download path: streamed — ${pieces(tally.downloadPieces)} pulled across the iframe`
}

/**
 * Count the proxy's messages to `target` from now until the returned `stop()`,
 * which hands back the tally. `proxyOrigin` may carry a path, as the demo's
 * identity URL does on GitHub Pages; only its origin is compared.
 */
export function watchBridgeTraffic(
  proxyOrigin: string,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
): () => BridgeTally {
  const origin = new URL(proxyOrigin).origin
  const tally = emptyTally()
  const listener = (event: Event) => {
    if (event instanceof MessageEvent && event.origin === origin) tallyMessage(tally, event.data)
  }
  target.addEventListener('message', listener)
  return () => {
    target.removeEventListener('message', listener)
    return tally
  }
}
