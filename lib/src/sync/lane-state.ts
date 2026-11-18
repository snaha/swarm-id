// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The published counter of one lane, as the context that holds the lane sees
 * it: what it resumed from, and what it has published since.
 *
 * A context that takes a lane calls `resume()` to learn the slots already
 * used, and after each upload `publish()` to make its own durable before the
 * upload is acknowledged. Who may do either is decided elsewhere
 * (`bus-lease.ts`); nothing here asks.
 */

import type { BatchId, Bee, PrivateKey, Stamper } from "@ethersphere/bee-js"
import type { CounterFrame } from "./counter-codec"
import {
  NUM_BUCKETS,
  UtilizationAwareStamper,
} from "../utils/batch-utilization"
import {
  readPartitionState,
  readStatePointer,
  writePartitionState,
  type StatePointer,
} from "./partition-state"

export interface LaneStateOptions {
  bee: Bee
  batchId: BatchId
  partition: number
  backupSigner: PrivateKey
  swarmEncryptionKey: Uint8Array
  stamper: Stamper
}

export class LaneState {
  /**
   * The newest published state this context's counter is in sync with: the
   * one it last read or wrote ITSELF. `seq: 0` with no reference stands for a
   * lane nothing was published on. Another context of this browser may have
   * published since, with a counter this one never saw, so the pointer the
   * stamper keeps in shared storage is only a place to start searching.
   */
  private published: { seq: number; referenceHex?: string } | undefined
  /**
   * A publish failed part-way, so its pointer entry may or may not have been
   * written. The next publish looks before it writes: an entry is never
   * written twice.
   */
  private publishUnsettled = false
  /**
   * The newest published state as this context read or wrote it: its leaf
   * refs, its frame and EXACTLY the counter they encode, so the next publish
   * re-uploads only the leaves that changed. Exactly, because a retained leaf
   * goes out under an exception list computed from the new counter, and a
   * leaf that encodes some other counter is one no reader can decode.
   */
  private publishedReferences: Uint8Array[] | undefined
  private publishedCounter: Uint32Array | undefined
  private publishedFrame: CounterFrame | undefined

  constructor(private readonly opts: LaneStateOptions) {}

  private get owner() {
    return this.opts.backupSigner.publicKey().address()
  }

  private get known(): StatePointer | undefined {
    const { seq, referenceHex } = this.published ?? { seq: 0 }
    return referenceHex === undefined ? undefined : { seq, referenceHex }
  }

  /**
   * Read the lane's published counter, for a context that has just taken the
   * lane. Returns the counter to stamp from, or `undefined` when the lane may
   * have a published state that could not be read: stamping from a guess
   * would re-issue used slots, so the caller must not write.
   */
  async resume(): Promise<Uint32Array | undefined> {
    const { bee, batchId, partition, swarmEncryptionKey, stamper } = this.opts
    const cached = stamper instanceof UtilizationAwareStamper
    const trusted = this.known
    const lookup = await readStatePointer({
      bee,
      owner: this.owner,
      swarmEncryptionKey,
      batchId,
      partition,
      known:
        trusted ??
        (cached ? await stamper.getSyncedPointer(partition) : undefined),
    })
    const state = await readPartitionState(
      {
        bee,
        owner: this.owner,
        swarmEncryptionKey,
        batchId,
        partition,
        prefetchedPointer: lookup,
      },
      trusted,
    )
    if (state.readFailed) return undefined

    if (state.unchanged) {
      // Nothing was published since this context last read or wrote the
      // lane, so the baseline it kept is still the newest state. Not the
      // stamper's counter: it serves every lane this context takes and holds
      // the one bound last. Stamps of an upload that was never acknowledged
      // are not in the baseline, and their slots are used again.
      this.publishUnsettled = false
      return this.publishedCounter?.slice() ?? new Uint32Array(NUM_BUCKETS)
    }

    const localCounter = state.localCounter ?? new Uint32Array(NUM_BUCKETS)
    if (state.referenceHex !== undefined && state.seq !== undefined && cached) {
      await stamper.setSyncedPointer(partition, {
        seq: state.seq,
        referenceHex: state.referenceHex,
      })
      if (state.stateBuckets) {
        await stamper.setProtectedStateBuckets(partition, state.stateBuckets)
      }
    }

    // The publish baseline is the state just read, so the first publish is
    // incremental. `publishedCounter` must be a COPY: the stamper mutates the
    // bound counter as it stamps, which would empty the diff.
    this.published = { seq: state.seq ?? 0, referenceHex: state.referenceHex }
    this.publishUnsettled = false
    this.publishedReferences = state.references
    this.publishedFrame = state.frame
    this.publishedCounter = localCounter.slice()
    return localCounter
  }

  /**
   * Publish `localCounter` as the lane's next state: the commit point that
   * makes an upload's slots durable before it is acknowledged. Whoever takes
   * the lane next resumes at exactly this counter.
   */
  async publish(localCounter: Uint32Array): Promise<void> {
    const { bee, batchId, partition, swarmEncryptionKey, stamper } = this.opts
    // The next entry is one past the newest. Not knowing the newest for sure
    // (a publish failed after it may have written its entry), look before
    // writing: writing an entry a second time is the one thing the sequence
    // must never do.
    if (this.published === undefined || this.publishUnsettled) {
      const { pointer, inconclusive } = await readStatePointer({
        bee,
        owner: this.owner,
        swarmEncryptionKey,
        batchId,
        partition,
        known: this.known,
      })
      if (inconclusive) {
        throw new Error(
          `[LaneState] partition ${partition}: could not tell which state ` +
            "pointer entry is the newest; not publishing over it.",
        )
      }
      this.published = pointer ?? { seq: 0 }
      this.publishUnsettled = false
    }
    this.publishUnsettled = true
    const published = await writePartitionState({
      bee,
      stamper,
      batchId,
      partition,
      localCounter,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey,
      seq: this.published.seq + 1,
      previousReferences: this.publishedReferences,
      previousCounter: this.publishedCounter,
      previousFrame: this.publishedFrame,
    })
    this.publishUnsettled = false
    this.publishedReferences = published.references
    this.publishedCounter = published.publishedCounter
    this.publishedFrame = published.frame
    this.published = {
      seq: published.seq,
      referenceHex: published.referenceHex,
    }
    if (stamper instanceof UtilizationAwareStamper) {
      const { seq, referenceHex } = published
      await stamper.setSyncedPointer(partition, { seq, referenceHex })
      await stamper.setProtectedStateBuckets(partition, published.stateBuckets)
    }
  }
}
