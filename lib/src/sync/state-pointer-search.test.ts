// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest"

import {
  entrySalt,
  findLatestSeq,
  searchPath,
  type Probe,
} from "./state-pointer-search"

const SAMPLES = [0, 1, 2, 7, 8, 9, 63, 64, 65, 100, 511, 512, 4095, 4096, 9999]
const MANY = 20_000

/** A store holding entries 1..latest, minus `missing`, counting its rounds. */
function store(latest: number, missing: ReadonlySet<number> = new Set()) {
  const rounds: number[][] = []
  return {
    rounds,
    read: (seqs: number[]): Promise<Probe[]> => {
      rounds.push(seqs)
      return Promise.resolve(
        seqs.map((seq) => seq <= latest && !missing.has(seq)),
      )
    },
  }
}

/** Deterministic pseudo-random integers, so a failure can be reproduced. */
function sequence(seed: number, count: number, below: number): number[] {
  let state = seed
  return Array.from({ length: count }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % below
  })
}

describe("findLatestSeq", () => {
  it.each(SAMPLES)("finds %i as the newest entry from nothing", async (n) => {
    const { read } = store(n)
    expect(await findLatestSeq({ known: 0, read })).toEqual({
      seq: n,
      inconclusive: false,
    })
  })

  it("finds the newest entry for many sizes and starting points", async () => {
    const latest = sequence(1, 200, MANY)
    const starts = sequence(2, 200, MANY)
    for (let i = 0; i < latest.length; i++) {
      const known = Math.min(starts[i], latest[i])
      const { read } = store(latest[i])
      const found = await findLatestSeq({ known, read })
      expect(found, `latest=${latest[i]} known=${known}`).toEqual({
        seq: latest[i],
        inconclusive: false,
      })
    }
  })

  it("takes a handful of small rounds for ten thousand entries", async () => {
    const { read, rounds } = store(9999)
    await findLatestSeq({ known: 0, read })
    expect(rounds.length).toBeLessThanOrEqual(8)
    expect(Math.max(...rounds.map((r) => r.length))).toBeLessThanOrEqual(11)
  })

  it("costs one round when nothing newer than the known entry exists", async () => {
    const { read, rounds } = store(9999)
    expect(await findLatestSeq({ known: 9999, read })).toEqual({
      seq: 9999,
      inconclusive: false,
    })
    expect(rounds).toHaveLength(1)
    expect(rounds[0].every((seq) => seq > 9999)).toBe(true)
  })

  it("never reads an entry at or below the known one", async () => {
    const { read, rounds } = store(9999)
    await findLatestSeq({ known: 5000, read })
    expect(rounds.flat().every((seq) => seq > 5000)).toBe(true)
  })

  // Only entries on the search path are kept; everything else may be gone.
  it("needs only the entries on the newest entry's search path", async () => {
    for (const n of SAMPLES.filter((s) => s > 0)) {
      const path = new Set(searchPath(n))
      const missing = new Set<number>()
      for (let seq = 1; seq <= n; seq++) if (!path.has(seq)) missing.add(seq)
      const { read } = store(n, missing)
      expect((await findLatestSeq({ known: 0, read })).seq, `n=${n}`).toBe(n)
    }
  })

  it("is inconclusive when a read above the newest entry found is unsettled", async () => {
    // 120 is the first entry read above 100 once 64 has bracketed the answer.
    const read = (seqs: number[]): Promise<Probe[]> =>
      Promise.resolve(seqs.map((seq) => (seq === 120 ? undefined : seq <= 100)))
    expect(await findLatestSeq({ known: 0, read })).toEqual({
      seq: 100,
      inconclusive: true,
    })
  })

  it("is conclusive when the unsettled read is below an entry that is present", async () => {
    // 64 and 512 are read in the same round; 512 being there settles it.
    const read = (seqs: number[]): Promise<Probe[]> =>
      Promise.resolve(seqs.map((seq) => (seq === 64 ? undefined : seq <= 600)))
    expect(await findLatestSeq({ known: 0, read })).toEqual({
      seq: 600,
      inconclusive: false,
    })
  })
})

describe("searchPath", () => {
  it("is small", () => {
    for (const n of [...SAMPLES, MANY, 1_000_000]) {
      expect(searchPath(n).length, `n=${n}`).toBeLessThanOrEqual(60)
    }
  })

  it("includes the entry itself and nothing above it", () => {
    for (const n of SAMPLES.filter((s) => s > 0)) {
      const path = searchPath(n)
      expect(path).toContain(n)
      expect(Math.max(...path)).toBe(n)
    }
    expect(searchPath(0)).toEqual([])
  })

  // The property the writer relies on: protect the path of what you write,
  // and every later search finds what it needs among the older entries.
  it("covers every older entry a search for a newer one reads", async () => {
    const olders = sequence(3, 150, MANY)
    const gaps = sequence(4, 150, MANY)
    for (let i = 0; i < olders.length; i++) {
      const older = olders[i] + 1
      const newer = older + gaps[i]
      const { read, rounds } = store(newer)
      await findLatestSeq({ known: 0, read })
      const kept = new Set(searchPath(older))
      const needed = rounds.flat().filter((seq) => seq <= older)
      for (const seq of needed) {
        expect(kept.has(seq), `older=${older} newer=${newer} seq=${seq}`).toBe(
          true,
        )
      }
    }
  })
})

describe("entrySalt", () => {
  const BUCKETS = 65_536
  const hashed = (seq: number, salt: number): number =>
    (seq * 2_654_435_761 + salt * 40_503) % BUCKETS

  it("is zero when the entry's bucket is clear", () => {
    expect(entrySalt(100, hashed)).toBe(0)
  })

  it("moves an entry off a bucket an earlier path entry could be at", () => {
    const earlier = searchPath(100).find((seq) => seq !== 100)
    expect(earlier).toBeDefined()
    const colliding = (seq: number, salt: number): number =>
      seq === 100 && salt === 0 ? hashed(earlier ?? 0, 1) : hashed(seq, salt)
    expect(entrySalt(100, colliding)).toBe(1)
  })

  it("keeps the entries of every search path in distinct buckets", () => {
    for (const n of sequence(5, 50, MANY)) {
      const buckets = searchPath(n + 1).map((seq) =>
        hashed(seq, entrySalt(seq, hashed)),
      )
      expect(new Set(buckets).size, `n=${n + 1}`).toBe(buckets.length)
    }
  })
})
