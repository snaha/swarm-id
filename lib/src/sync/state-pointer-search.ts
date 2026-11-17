// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding the newest entry of a numbered, write-once sequence.
 *
 * A partition's state pointer is published as entry 1, 2, 3, … — each at its
 * own address, never rewritten — and a reader has to find the highest number
 * written. It cannot ask for "the latest", and it cannot trust that every old
 * entry is still stored: entries share the partition's reserved stamp slot, so
 * a later write that falls in the same bucket replaces an earlier one.
 *
 * So the search is CANONICAL: which entries it reads depends only on the
 * answer, never on where the reader starts. That gives the writer a small,
 * computable set of entries that any future search may read
 * (`searchPath`), and it keeps exactly those from being replaced.
 *
 * Shape: read the powers of `FANOUT` to bracket the answer, then split the
 * bracket `FANOUT` ways until it is one entry wide. About six rounds of at
 * most ten reads for ten thousand entries.
 */

const FANOUT = 8
/** `FANOUT ** MAX_POWER` entries is more than a batch will ever see. */
const MAX_POWER = 10

/** Whether an entry is stored; `undefined` when the read did not settle it. */
export type Probe = boolean | undefined

/**
 * The search as a sequence of rounds: yields the entry numbers to read, is
 * resumed with one `Probe` per number, and returns the highest entry present
 * (`0` for none) with whether a read that could have changed the answer was
 * left unsettled.
 *
 * Within a round the HIGHEST present entry wins. An absent entry below a
 * present one is an entry that was replaced or misread, and presence cannot
 * be mistaken: an entry is signed and names its own number.
 */
function* rounds(): Generator<
  number[],
  { seq: number; inconclusive: boolean },
  Probe[]
> {
  let inconclusive = false
  const highestPresent = (results: Probe[]): number => {
    const index = results.lastIndexOf(true)
    if (results.slice(index + 1).includes(undefined)) inconclusive = true
    return index
  }

  const powers = Array.from({ length: MAX_POWER + 1 }, (_, k) => FANOUT ** k)
  const power = highestPresent(yield powers)
  if (power < 0) return { seq: 0, inconclusive }

  let lo = powers[power]
  let hi = lo * FANOUT
  while (hi - lo > 1) {
    const step = Math.max(1, Math.ceil((hi - lo) / FANOUT))
    const probes: number[] = []
    for (let seq = lo + step; seq < hi; seq += step) probes.push(seq)
    const index = highestPresent(yield probes)
    hi = index + 1 < probes.length ? probes[index + 1] : hi
    lo = index < 0 ? lo : probes[index]
  }
  return { seq: lo, inconclusive }
}

/** Every entry a search reads when the newest entry is `seq`. */
function probesFor(seq: number): number[] {
  const all: number[] = []
  const search = rounds()
  let step = search.next()
  while (!step.done) {
    all.push(...step.value)
    step = search.next(step.value.map((probe) => probe <= seq))
  }
  return all
}

/**
 * The entries at or below `seq` that a search may read once `seq` has been
 * written, now or after any number of later entries — `seq` itself included.
 * These must stay stored.
 */
export function searchPath(seq: number): number[] {
  const path = new Set(probesFor(seq).filter((probe) => probe <= seq))
  if (seq > 0) path.add(seq)
  return [...path].sort((a, b) => a - b)
}

/**
 * Find the newest entry.
 *
 * `known` is an entry the caller knows was written (its own last publish, or
 * `0`): entries at or below it are not read. When nothing newer exists, which
 * is the usual case, every read the search needs is known up front, so they
 * are issued together and the search costs one round.
 */
export async function findLatestSeq(opts: {
  known: number
  read: (seqs: number[]) => Promise<Probe[]>
}): Promise<{ seq: number; inconclusive: boolean }> {
  const cache = new Map<number, Probe>()
  const readThrough = async (seqs: number[]): Promise<Probe[]> => {
    const missing = seqs.filter((seq) => seq > opts.known && !cache.has(seq))
    if (missing.length > 0) {
      const results = await opts.read(missing)
      missing.forEach((seq, i) => cache.set(seq, results[i]))
    }
    return seqs.map((seq) => (seq <= opts.known ? true : cache.get(seq)))
  }

  await readThrough(probesFor(opts.known))

  const search = rounds()
  let step = search.next()
  while (!step.done) step = search.next(await readThrough(step.value))
  return step.value
}

/**
 * How many addresses an entry can be written at. Each one more makes it less
 * likely that all of them are taken: at eight, about one publish in 10^17.
 */
const SALTS = 8

/**
 * Which of an entry's few possible addresses it is written at.
 *
 * Two entries on one search path must not share a bucket, or writing the
 * later one replaces the earlier. An entry therefore takes the first salt
 * whose bucket is clear of every address the earlier entries on its path
 * could be at. Reader and writer compute the same answer from the entry
 * number alone, so there is no refusing: with every salt taken, the last one
 * is used and the earlier entry in that bucket is replaced.
 */
export function entrySalt(
  seq: number,
  bucketOf: (seq: number, salt: number) => number,
): number {
  const taken = new Set<number>()
  for (const earlier of searchPath(seq)) {
    if (earlier === seq) continue
    for (let salt = 0; salt < SALTS; salt++) {
      taken.add(bucketOf(earlier, salt))
    }
  }
  for (let salt = 0; salt < SALTS - 1; salt++) {
    if (!taken.has(bucketOf(seq, salt))) return salt
  }
  return SALTS - 1
}
