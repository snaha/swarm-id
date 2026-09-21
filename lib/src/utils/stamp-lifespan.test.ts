// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"
import {
  stampRefusal,
  isStampExpired,
  remainingLifespanSeconds,
  sameStampLifetime,
} from "./stamp-lifespan"

const NOW = 2_000_000_000_000
const MINUTE_MS = 60_000

describe("remainingLifespanSeconds", () => {
  it("ages the stored snapshot from when it was measured", () => {
    const stamp = { batchTTL: 600, createdAt: NOW - 5 * MINUTE_MS }
    expect(remainingLifespanSeconds(stamp, NOW)).toBe(300)
  })

  it("prefers updatedAt, the instant a node operation re-measured it", () => {
    const stamp = {
      batchTTL: 600,
      createdAt: NOW - 60 * MINUTE_MS,
      updatedAt: NOW - MINUTE_MS,
    }
    expect(remainingLifespanSeconds(stamp, NOW)).toBe(540)
  })

  it("is undefined when the lifetime was never measured", () => {
    expect(remainingLifespanSeconds({ createdAt: NOW }, NOW)).toBeUndefined()
  })
})

describe("isStampExpired", () => {
  it("is false for a live stamp and for one with an unknown lifetime", () => {
    expect(isStampExpired({ batchTTL: 60, createdAt: NOW }, NOW)).toBe(false)
    expect(isStampExpired({ createdAt: NOW - MINUTE_MS }, NOW)).toBe(false)
  })

  it("is true once the aged lifetime reaches zero", () => {
    expect(
      isStampExpired({ batchTTL: 60, createdAt: NOW - MINUTE_MS }, NOW),
    ).toBe(true)
  })
})

describe("sameStampLifetime", () => {
  const stamp = { batchTTL: 60, createdAt: NOW - MINUTE_MS }

  it("is true for records that age the same way, and for two absences", () => {
    expect(sameStampLifetime(stamp, { ...stamp })).toBe(true)
    expect(sameStampLifetime(undefined, undefined)).toBe(true)
  })

  it("notices a renewal: same batch, new TTL or a later measurement", () => {
    expect(sameStampLifetime(stamp, { ...stamp, batchTTL: 600 })).toBe(false)
    expect(sameStampLifetime(stamp, { ...stamp, updatedAt: NOW })).toBe(false)
    expect(sameStampLifetime(stamp, undefined)).toBe(false)
  })
})

// #765: the stored record also says whether the node has the batch and whether
// it is usable. A dApp gating on `canUpload` alone saw `true`, uploaded, and
// met the refusal as a 30 s timeout.
describe("stampRefusal", () => {
  const fresh = { batchTTL: 600, createdAt: Date.now() }

  it("is undefined for a live, usable, existing record", () => {
    expect(stampRefusal({ ...fresh, usable: true, exists: true })).toBe(
      undefined,
    )
  })

  it("is undefined when the record predates the fields", () => {
    expect(stampRefusal(fresh)).toBe(undefined)
  })

  it("names expiry before usability", () => {
    expect(
      stampRefusal({ batchTTL: 0, createdAt: Date.now(), usable: false }),
    ).toBe("stamp-expired")
  })

  it("is stamp-not-usable when the record says so", () => {
    expect(stampRefusal({ ...fresh, usable: false })).toBe("stamp-not-usable")
    expect(stampRefusal({ ...fresh, exists: false })).toBe("stamp-not-usable")
  })
})

describe("sameStampLifetime notices a usability flip", () => {
  it("differs when only usable or exists changed", () => {
    const at = Date.now()
    const a = { batchTTL: 600, createdAt: at, usable: false }
    expect(sameStampLifetime(a, { ...a, usable: true })).toBe(false)
    expect(sameStampLifetime(a, { ...a, exists: false })).toBe(false)
    expect(sameStampLifetime(a, { ...a })).toBe(true)
  })
})
