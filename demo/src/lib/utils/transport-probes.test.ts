// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The probes answer for the engine they run on, so these assert only that each
 * one finishes with a well-formed observation — here, on Node's. What a
 * browser answers is the Safari check page's to show.
 */
import { describe, expect, it } from 'vitest'

import { BLOB_PROBE_BYTES } from './safari-check'
import { probeBlobStream, probeStreamTransfer } from './transport-probes'

describe('probeStreamTransfer', () => {
  it('finishes with what the transfer did', async () => {
    const observation = await probeStreamTransfer()
    expect(['arrived', 'threw', 'lost']).toContain(observation.outcome)
  })
})

describe('probeBlobStream', () => {
  it('counts the pieces of the probe blob, none larger than the blob', async () => {
    const observation = await probeBlobStream()
    expect(observation.size).toBe(BLOB_PROBE_BYTES)
    expect(observation.pieces).toBeGreaterThan(0)
    expect(observation.largestPiece).toBeGreaterThan(0)
    expect(observation.largestPiece).toBeLessThanOrEqual(BLOB_PROBE_BYTES)
  })
})
