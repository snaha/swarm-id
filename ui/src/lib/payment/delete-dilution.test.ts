// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'

import { type DilutionInput, planDeleteDilution } from './delete-dilution'
import { FLOOR_MARGIN_BLOCKS } from './purchase'

const SIGNER = `0x${'ab'.repeat(20)}`
const OTHER = `0x${'2'.repeat(40)}`
const BLOCKS_PER_DAY = 17_280n
const PRICE = 24_000n
/** ~1 day of storage, the contract's floor. */
const MINIMUM = BLOCKS_PER_DAY * PRICE
/** What a dilution must leave per chunk: the floor plus the decay margin. */
const FLOOR = MINIMUM + PRICE * FLOOR_MARGIN_BLOCKS
const DEPTH = 20

function input(overrides: Partial<DilutionInput> = {}, remaining = 50n * MINIMUM): DilutionInput {
  return {
    chain: { depth: DEPTH, remaining, owner: SIGNER, immutable: false },
    signerAddress: SIGNER,
    minimumBalancePerChunk: MINIMUM,
    lastPrice: PRICE,
    keep: false,
    ...overrides,
  }
}

/** The per-chunk balance a planned dilution leaves behind. */
function postDilution(remaining: bigint, targetDepth: number): bigint {
  return remaining >> BigInt(targetDepth - DEPTH)
}

describe('planDeleteDilution', () => {
  it('dilutes as far as the balance allows, leaving between one and two floors', () => {
    const remaining = 50n * MINIMUM
    const plan = planDeleteDilution(input({}, remaining))

    // 50 floors' worth halves five times before it would drop below one.
    expect(plan).toEqual({ targetDepth: DEPTH + 5 })
    if (!('targetDepth' in plan)) throw new Error('expected a dilution')
    const left = postDilution(remaining, plan.targetDepth)
    expect(left).toBeGreaterThanOrEqual(MINIMUM)
    expect(left).toBeGreaterThanOrEqual(FLOOR)
    expect(left).toBeLessThan(2n * FLOOR)
  })

  it('dilutes by one step at exactly two floors', () => {
    expect(planDeleteDilution(input({}, 2n * FLOOR))).toEqual({ targetDepth: DEPTH + 1 })
  })

  it('reports expires-soon one PLUR below two floors', () => {
    expect(planDeleteDilution(input({}, 2n * FLOOR - 1n))).toEqual({ skip: 'expires-soon' })
  })

  it('reports expires-soon for a drive already below the floor', () => {
    expect(planDeleteDilution(input({}, MINIMUM / 2n))).toEqual({ skip: 'expires-soon' })
  })

  // What makes a retried deletion idempotent: the drive a first attempt
  // diluted is left inside [floor, 2·floor), and planning it again finds no
  // step to take rather than diluting it below what the contract accepts.
  it('plans nothing more for a drive it already diluted', () => {
    const remaining = 1000n * MINIMUM
    const first = planDeleteDilution(input({}, remaining))
    if (!('targetDepth' in first)) throw new Error('expected a dilution')

    const retried = planDeleteDilution(
      input({
        chain: {
          depth: first.targetDepth,
          remaining: postDilution(remaining, first.targetDepth),
          owner: SIGNER,
          immutable: false,
        },
      }),
    )

    expect(retried).toEqual({ skip: 'expires-soon' })
  })

  it('keeps a drive the user chose to keep, whatever its balance', () => {
    expect(planDeleteDilution(input({ keep: true }))).toEqual({ skip: 'kept' })
    // Kept wins even where the chain could not describe the drive.
    expect(planDeleteDilution(input({ keep: true, chain: undefined }))).toEqual({ skip: 'kept' })
  })

  it('reports a batch the chain no longer has as expired', () => {
    expect(planDeleteDilution(input({ chain: undefined }))).toEqual({ skip: 'expired' })
  })

  it('reports a batch with nothing left as expired', () => {
    expect(planDeleteDilution(input({}, 0n))).toEqual({ skip: 'expired' })
  })

  it('leaves a batch owned by another key alone', () => {
    expect(
      planDeleteDilution(
        input({
          chain: { depth: DEPTH, remaining: 50n * MINIMUM, owner: OTHER, immutable: false },
        }),
      ),
    ).toEqual({ skip: 'not-owned' })
  })

  it('compares owners case-insensitively', () => {
    expect(
      planDeleteDilution(
        input({
          chain: {
            depth: DEPTH,
            remaining: 50n * MINIMUM,
            owner: SIGNER.toUpperCase().replace('0X', '0x'),
            immutable: false,
          },
        }),
      ),
    ).toEqual({ targetDepth: DEPTH + 5 })
  })

  it('leaves an immutable batch alone', () => {
    expect(
      planDeleteDilution(
        input({
          chain: { depth: DEPTH, remaining: 50n * MINIMUM, owner: SIGNER, immutable: true },
        }),
      ),
    ).toEqual({ skip: 'immutable' })
  })
})
