// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import {
  describeDownload,
  describeUpload,
  emptyTally,
  tallyMessage,
  watchBridgeTraffic,
} from './bridge-traffic'

const PROXY_ORIGIN = 'http://localhost:5500'
/** A 4 MiB file in 256 KiB pieces */
const FILE_PIECES = 16

function pulls(requestId: string, count: number, index?: number) {
  return Array.from({ length: count }, () => ({ type: 'uploadSourcePull', requestId, index }))
}

describe('tallyMessage', () => {
  it('counts pulls, and the sources they name', () => {
    const tally = emptyTally()
    for (const message of [...pulls('r1', 2, 0), ...pulls('r1', 1, 1)]) {
      tallyMessage(tally, message)
    }
    expect(tally.pulls).toBe(3)
    expect(tally.sources.size).toBe(2)
  })

  // The end marker is a piece message with no bytes: it ends the stream, it is not a piece.
  it('counts download pieces that carry bytes, not the end marker', () => {
    const tally = emptyTally()
    tallyMessage(tally, { type: 'downloadStreamPiece', requestId: 'r1', data: new Uint8Array(1) })
    tallyMessage(tally, { type: 'downloadStreamPiece', requestId: 'r1' })
    expect(tally.downloadPieces).toBe(1)
    expect(tally.downloadEnds).toBe(1)
  })

  it('ignores every other message', () => {
    const tally = emptyTally()
    // `null` included: any window may post it to this one.
    for (const data of [undefined, null, 'uploadSourcePull', 7, { type: 'uploadProgress' }, {}]) {
      tallyMessage(tally, data)
    }
    expect(tally).toEqual(emptyTally())
  })
})

describe('describeUpload', () => {
  it('reports no pulls as one buffered message', () => {
    expect(describeUpload(emptyTally())).toBe('Upload path: buffered — sent in one message')
  })

  // One pull per piece, and one more that the end marker answers.
  it('reports a streamed file’s pieces, its end-marker pull left out', () => {
    const tally = emptyTally()
    for (const message of pulls('r1', FILE_PIECES + 1)) tallyMessage(tally, message)
    expect(describeUpload(tally)).toBe(
      `Upload path: streamed — ${FILE_PIECES} pieces pulled across the iframe`,
    )
  })

  it('reports a folder’s pieces across its files', () => {
    const tally = emptyTally()
    for (const message of [...pulls('r1', 2, 0), ...pulls('r1', 2, 1)]) {
      tallyMessage(tally, message)
    }
    expect(describeUpload(tally)).toBe(
      'Upload path: streamed — 2 pieces pulled across the iframe, from 2 files',
    )
  })

  it('says “piece” for one', () => {
    const tally = emptyTally()
    for (const message of pulls('r1', 2)) tallyMessage(tally, message)
    expect(describeUpload(tally)).toBe('Upload path: streamed — 1 piece pulled across the iframe')
  })
})

describe('describeDownload', () => {
  it('reports no pieces as one buffered message', () => {
    expect(describeDownload(emptyTally())).toBe('Download path: buffered — received in one message')
  })

  it('reports the pieces of a streamed download', () => {
    const tally = emptyTally()
    tally.downloadPieces = FILE_PIECES
    tally.downloadEnds = 1
    expect(describeDownload(tally)).toBe(
      `Download path: streamed — ${FILE_PIECES} pieces pulled across the iframe`,
    )
  })

  // An empty file streams too: no piece, only the end marker.
  it('reports an empty streamed download as streamed', () => {
    const tally = emptyTally()
    tallyMessage(tally, { type: 'downloadStreamPiece', requestId: 'r1' })
    expect(describeDownload(tally)).toBe(
      'Download path: streamed — 0 pieces pulled across the iframe',
    )
  })
})

describe('watchBridgeTraffic', () => {
  function post(target: EventTarget, origin: string, data: unknown) {
    target.dispatchEvent(new MessageEvent('message', { origin, data }))
  }

  it('counts the proxy origin’s messages until stopped', () => {
    const target = new EventTarget()
    const stop = watchBridgeTraffic(PROXY_ORIGIN, target)
    post(target, PROXY_ORIGIN, { type: 'uploadSourcePull', requestId: 'r1' })
    post(target, 'http://localhost:3500', { type: 'uploadSourcePull', requestId: 'r2' })
    const tally = stop()
    post(target, PROXY_ORIGIN, { type: 'uploadSourcePull', requestId: 'r1' })
    expect(tally.pulls).toBe(1)
  })

  // The identity URL carries a path on GitHub Pages (`…/id`); a message's origin never does.
  it('compares only the origin of an identity URL with a path', () => {
    const target = new EventTarget()
    const stop = watchBridgeTraffic('https://swarm.snaha.net/id', target)
    post(target, 'https://swarm.snaha.net', { type: 'uploadSourcePull', requestId: 'r1' })
    expect(stop().pulls).toBe(1)
  })
})
