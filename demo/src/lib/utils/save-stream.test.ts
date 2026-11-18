// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveStream } from './save-stream'

const NAME = 'report.pdf'
const BYTES = new Uint8Array([1, 2, 3])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** A browser whose save picker hands back `handle`, and whose Blob downloads are recorded */
function stubBrowser(handle: { createWritable: () => Promise<WritableStream<Uint8Array>> }) {
  const clicked = vi.fn()
  vi.stubGlobal('window', { showSaveFilePicker: async () => handle })
  vi.stubGlobal('document', {
    createElement: () => ({ click: clicked, remove: vi.fn() }),
    body: { appendChild: vi.fn() },
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { clicked }
}

describe('saveStream', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('writes the stream into the chosen file', async () => {
    const written: Uint8Array[] = []
    stubBrowser({
      createWritable: async () =>
        new WritableStream({ write: (chunk) => void written.push(chunk) }),
    })

    const outcome = await saveStream(NAME, async () => ({ stream: streamOf(BYTES) }))

    expect(outcome.path).toBe('picker')
    expect(written).toEqual([BYTES])
  })

  it('falls back to a Blob download when the chosen file will not open for writing', async () => {
    const { clicked } = stubBrowser({
      createWritable: async () => {
        throw new DOMException('not allowed', 'NotAllowedError')
      },
    })
    const open = vi.fn(async () => ({ stream: streamOf(BYTES) }))

    const outcome = await saveStream(NAME, open)

    expect(outcome).toMatchObject({ path: 'blob', reason: expect.stringContaining('not allowed') })
    expect(open).toHaveBeenCalledTimes(1)
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})
