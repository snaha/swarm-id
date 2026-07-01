// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Consolidated partition-lease state.
 *
 * This is the single in-code model of "who holds which partition" for one
 * account+batch. The per-partition lock SOC on Swarm
 * (`partition-lock.ts`) remains the cross-device authority; this class is
 * the one structure every code path consults, replacing the previous trio
 * of scattered representations (the `LeaseState` localStorage blob, the
 * `activeDevices` snapshot mirror, and ad-hoc `holderDeviceId` reads).
 *
 * It holds:
 *   - `self`         — this device's own lease (undefined when not holding)
 *   - `holders`      — observed holder per partition, derived from the lock
 *                      SOCs; this is what models the up-to-`partitionCount`
 *                      simultaneously-active devices
 *   - admin          — deviceId / batchId / partitionCount
 *
 * The proxy owns one instance, persists it as a *cache*
 * (`serialize`/`deserialize`), and re-validates against the lock SOC before
 * trusting `self`. Only the proxy mutates lock SOCs; readers (the SwarmID
 * UI) construct a read-only instance and call `refreshFromSwarm` +
 * `getHolders` to inspect the live holders.
 */

import {
  Bee,
  BatchId,
  PrivateKey,
  Reference,
  type Stamper,
} from "@ethersphere/bee-js"
import { uint8ArrayToHex } from "../utils/hex"
import { withTimeout } from "../utils/promise"
import { deriveSecret } from "../utils/key-derivation"
import {
  LEASE_TTL_MS,
  NUM_BUCKETS,
  UtilizationAwareStamper,
  toBucket,
} from "../utils/batch-utilization"
import { lockSocBucket } from "../utils/lock-soc"
import {
  acquirePartitionLock,
  compareGenerations,
  deviceHomePartition,
  makeDeviceTiebreaker,
  NO_HOLDER_DEVICE_ID,
  readPartitionLock,
  releasePartitionLock,
  type PartitionLockGeneration,
  type PartitionLockPayload,
} from "./partition-lock"
import {
  INTENT_GUARD_POLL_MS,
  INTENT_GUARD_WINDOW_MS,
  INTENT_LIVENESS_GRACE_MS,
  intentEpochBucket,
  intentSocAddress,
  partitionOccupancyAddress,
  readPartitionIntent,
  readPartitionOccupancy,
  resolveIntentRound,
  writePartitionIntent,
  writePartitionOccupancy,
} from "./partition-intent"
import {
  readPartitionState,
  statePointerAddress,
  writePartitionState,
  writeStatePointer,
} from "./partition-state"

/** Default guard time δ for the lock protocol (iteration-2 doc § δ tuning). */
export const PARTITION_LOCK_GUARD_MS = 2000

/** True when a 64-byte reference is the all-zero sentinel (a never-written
 *  counter chunk — see `ZERO_CHUNK_REF` in partition-state.ts). */
function isZeroRef(ref: Uint8Array): boolean {
  for (let i = 0; i < ref.length; i++) if (ref[i] !== 0) return false
  return true
}

/**
 * Bound each lock-SOC read in `refreshFromSwarm` so a hanging read on a slow
 * gateway is classified as "unreadable" (a takeover then fails safe) rather than
 * silently treated as an absent lock. Matches the roster / state-pointer read
 * timeouts.
 */
const LOCK_READ_TIMEOUT_MS = 2500

/** This device's own lease over a partition. */
export interface SelfLease {
  partition: number
  generation: PartitionLockGeneration
  acquiredAt: number
  leasedUntil: number
}

/** An observed holder of a partition (from the lock SOC). */
export interface PartitionHolderEntry {
  deviceId: string
  generation: PartitionLockGeneration
  acquiredAt: number
  leasedUntil: number
}

/** Inputs the orchestrator needs to dispatch a case. */
export interface PartitionLeaseSnapshotInputs {
  partitionCount: number
}

/** Result of `acquire()` (or the legacy fall-through). */
export interface AcquireResult {
  /**
   * The partition this device holds, or `undefined` for legacy mode and
   * the read-only path (every partition is held by a live foreign holder).
   */
  partition: number | undefined
  partitionCount: number
  localCounter: Uint32Array
  isReadOnly: boolean
  /** Latest lock-SOC payload observed after acquire. Undefined when read-only. */
  lockPayload?: PartitionLockPayload
}

/**
 * Outcome of a `refresh()` tick. Distinguishes the two ways a refresh can fail
 * to keep the lease, because the coordinator must react to them differently:
 *
 * - `"held"`     — the lease is still ours and was extended.
 * - `"lost"`     — could not confirm via write+verify (no lease, or the lock
 *                  protocol returned `blocked`/`lost-race`/`aborted`). The
 *                  caller should re-check the static lock SOC before demoting
 *                  (a transient read-your-writes hiccup must not demote — the
 *                  Phase-1 optimism).
 * - `"displaced"` — a foreign PRESENCE BEACON with an earlier generation proved
 *                  a peer already holds this partition. The beacon is read at a
 *                  fresh per-epoch address — the channel that stays readable on
 *                  a disjoint gateway where the static lock SOC is frozen — so
 *                  this is a CONFIRMED displacement. The caller MUST demote
 *                  directly and must NOT re-gate on the static lock SOC: by the
 *                  time `refresh()` returns, it has already rewritten our own
 *                  claim to that address, so a re-read there would see SELF and
 *                  never confirm (the no-op the deconfliction backstop existed
 *                  to avoid).
 */
export type LeaseRefreshOutcome = "held" | "lost" | "displaced"

/**
 * Serialised form of the lease state, used as the local persistence cache.
 * Never trusted on its own — callers re-validate `self` against the lock
 * SOC before acting on it.
 */
export interface PartitionLeaseStateSnapshot {
  deviceId: string
  batchId: string
  self?: SelfLease
}

export class PartitionLease {
  private self: SelfLease | undefined
  /** Per-partition holders observed by the last `refreshFromSwarm()`. */
  private holders = new Map<number, PartitionHolderEntry>()
  /**
   * Partitions whose lock SOC carried an explicit NO_HOLDER release sentinel in
   * the last `refreshFromSwarm()`, mapped to the RELEASED claim's generation —
   * the release WATERMARK. An authoritative "free" — distinct from a
   * stale/expired lock — so the holder-detection paths
   * (`refreshHoldersFromPresence` / `refreshHoldersFromOccupancy`) must NOT let
   * a lingering beacon (the just-released holder's, still within TTL) re-mark it
   * held and block an immediate takeover. The generation watermark additionally
   * lets the intent round and the `refresh()` displacement checks
   * (`beaconOutranksRelease`) tell that holder's stale GHOST beacon (gen ≤
   * watermark) from a genuine post-release claimant (gen > watermark).
   */
  private releasedPartitions = new Map<number, PartitionLockGeneration>()
  /**
   * Last `leasedUntil` observed on a partition's lock SOC that is NOT a live
   * holder — an EXPIRED holder, or a release sentinel (whose `leasedUntil` is the
   * release time). The gone holder heartbeats its rotating state-pointer SOC up to
   * its `leasedUntil`, so this bounds the pointer's last bucket and lets a DELAYED
   * takeover compute the right address (the pointer ages out of the `now` buckets
   * otherwise — `holders` only carries LIVE holders' `leasedUntil`). Keyed by
   * partition; rebuilt each `refreshFromSwarm`.
   */
  private lastSeenLeasedUntil = new Map<number, number>()
  /**
   * Partitions whose lock SOC could not be read conclusively this refresh — the
   * read timed out / hung (a transient failure), NOT a clean "absent" 404. For
   * such a partition, `holderLeasedUntilMs` is unknown, so a takeover that finds
   * no pointer must fail safe (read-only) instead of resuming from zero and
   * re-issuing a gone holder's acked slots. Rebuilt each `refreshFromSwarm`.
   * A clean 404 (genuinely free partition) is NOT recorded here, so first-claim
   * from zero still works.
   */
  private unreadableLocks = new Set<number>()
  /**
   * Cached state from this session's last partition-state publish, so the next
   * publish re-uploads only the chunks that changed (incremental). Seeded on the
   * first publish (full), refreshed on every publish, and cleared by `acquire()`
   * (a new session resumes from a peer's counter, not our stale one).
   */
  private publishedReferences: Uint8Array[] | undefined
  private publishedCounter: Uint32Array | undefined
  /** Reference-chunk ref (hex) of this session's last publish — re-written to the
   *  current rotating bucket on each refresh tick (heartbeat) so an idle holder
   *  keeps a fresh state pointer the next reader can find. */
  private lastReferenceHex: string | undefined
  /**
   * Epoch bucket of the last FULL (non-incremental) publish. An incremental
   * publish leaves unchanged counter chunks in place across epochs, but the
   * rotating pointer/occupancy/intent SOCs share this partition's reserved slot
   * and a LATER epoch's (deterministic) bucket can collide with a long-retained
   * chunk and evict it — only the current+previous epoch's beacon buckets are
   * excluded at publish time (see `writePartitionState`). So we force one FULL
   * re-pin per epoch: every non-zero chunk is re-uploaded at a fresh bucket clear
   * of the current epoch's beacons, so any such eviction self-heals within ~1
   * epoch while the holder lives (only a collision in the final pre-departure
   * epoch is left for the takeover `readFailed` path). undefined after `acquire`.
   */
  private lastFullPublishEpoch: number | undefined
  /**
   * Set at the start of `release()` (the lease session is closing) and
   * cleared by the next `acquire()`. While set, an overlapping `refresh()`
   * aborts before its claim write — otherwise it could mint a ghost claim
   * NEWER than the generation the in-flight release is fenced to, which the
   * release would then refuse to clear (peers would wait out the TTL).
   */
  private closed = false

  constructor(
    private readonly opts: {
      bee: Bee
      deviceId: string
      swarmEncryptionKey: Uint8Array
      /** Backup signer for the partition-lock SOC and partition-state feed. */
      backupSigner: PrivateKey
      /**
       * Batch + stamper are only needed for the WRITE paths (acquire,
       * refresh, release). They're optional so a reader — e.g. the SwarmID
       * UI's Devices tab — can build a lease purely to `refreshFromSwarm`
       * and inspect holders without a stamper.
       */
      batchId?: BatchId
      batchDepth?: number
      /**
       * Stamper used to upload the small payload chunks (lock SOC, state
       * feed). In practice this is the `UtilizationAwareStamper` the proxy
       * uses for data uploads. Omitted for read-only use.
       */
      stamper?: Stamper
      /** Override for tests; defaults to `() => Date.now()`. */
      now?: () => number
      /** Override for tests; defaults to PARTITION_LOCK_GUARD_MS. */
      guardMs?: number
      /**
       * Current known device IDs for this account (from the synced device
       * registry). Read fresh each round so it reflects late-announced
       * devices. When provided with ≥1 rival, a fresh claim of a free
       * partition first runs an intent round (Phase 2 — see
       * `partition-intent.ts`) so disjoint-gateway contenders agree on one
       * winner before binding. Omitted (or empty) → today's guard+TTL path.
       */
      knownDeviceIds?: () => string[]
      /** Override for tests; per-rival intent-read timeout. */
      intentReadTimeoutMs?: number
      /**
       * Fresh-claim intent-round poll window / interval (gateway-propagation
       * tunable). Default to the `INTENT_GUARD_*` constants; tests pass 0 for a
       * single immediate read.
       */
      intentGuardWindowMs?: number
      intentGuardPollMs?: number
    },
  ) {}

  /**
   * Build a `PartitionLease` whose `backupSigner` is derived from the
   * account's `swarmEncryptionKey` (same derivation as the partition-state
   * and partition-lock feeds). Pass `stamper`/`batchId`/`batchDepth` for the
   * write path; omit them for a read-only lease (UI display).
   */
  static async fromSwarmEncryptionKey(opts: {
    bee: Bee
    deviceId: string
    swarmEncryptionKey: Uint8Array
    batchId?: BatchId
    batchDepth?: number
    stamper?: Stamper
    now?: () => number
    guardMs?: number
    knownDeviceIds?: () => string[]
    intentReadTimeoutMs?: number
    intentGuardWindowMs?: number
    intentGuardPollMs?: number
  }): Promise<PartitionLease> {
    const swarmEncryptionKeyHex = uint8ArrayToHex(opts.swarmEncryptionKey)
    const backupKeyHex = await deriveSecret(swarmEncryptionKeyHex, "backup-key")
    const backupSigner = new PrivateKey(backupKeyHex)
    return new PartitionLease({ ...opts, backupSigner })
  }

  /**
   * Read every partition's lock SOC and populate `holders` with the live
   * (unexpired, non-released) ones. The single source of truth for "who is
   * active" — used by `isActive`, `heldPartition`, and `pickFreeOrExpired`.
   */
  async refreshFromSwarm(partitionCount: number): Promise<void> {
    const now = this.now()
    this.holders.clear()
    this.releasedPartitions.clear()
    this.lastSeenLeasedUntil.clear()
    this.unreadableLocks.clear()
    // Read every partition's lock SOC in parallel — each is an independent
    // multi-round-trip retrieval, so overlapping them collapses N×latency into
    // ≈1×. Classification below is order-independent (holders/releasedPartitions
    // are partition-keyed). Each read is bounded by a timeout we generate, so a
    // HANGING read (slow gateway) is an unambiguous "unreadable" signal — recorded
    // so a takeover of this partition fails safe rather than zero-seeding. A fast
    // `undefined` (clean 404) is genuinely absent and stays claimable.
    const locks = await Promise.all(
      Array.from({ length: partitionCount }, (_unused, p) =>
        withTimeout(
          readPartitionLock({
            bee: this.opts.bee,
            backupSigner: this.opts.backupSigner,
            swarmEncryptionKey: this.opts.swarmEncryptionKey,
            partition: p,
          }),
          LOCK_READ_TIMEOUT_MS,
          "lock read timed out",
        ).catch(() => {
          this.unreadableLocks.add(p)
          return undefined
        }),
      ),
    )
    for (let p = 0; p < partitionCount; p++) {
      const lock = locks[p]
      // Per-partition outcome — this is the line that reveals whether a joining
      // device can actually SEE the current holder's lock SOC (the suspected
      // cross-device dual-acquire cause). "no readable lock" here for a
      // partition a peer holds = the lock SOC is invisible to us.
      if (!lock) {
        console.debug(`[PartitionLease] refresh p=${p}: no readable lock`)
        continue
      }
      if (lock.holderDeviceId === NO_HOLDER_DEVICE_ID) {
        console.debug(`[PartitionLease] refresh p=${p}: released sentinel`)
        this.releasedPartitions.set(p, lock.generation)
        // The sentinel's `leasedUntil` is the release time; the releaser's final
        // state-pointer write sits in that bucket, so a delayed takeover can find it.
        this.lastSeenLeasedUntil.set(p, lock.leasedUntil)
        continue
      }
      const self = lock.holderDeviceId === this.opts.deviceId ? " (self)" : ""
      if (lock.leasedUntil <= now) {
        console.debug(
          `[PartitionLease] refresh p=${p}: EXPIRED holder ${lock.holderDeviceId}${self} (until ${lock.leasedUntil} <= now ${now})`,
        )
        // The expired holder heartbeated its state pointer up to `leasedUntil`;
        // retain it so a takeover computes the pointer bucket even long after.
        this.lastSeenLeasedUntil.set(p, lock.leasedUntil)
        continue
      }
      console.debug(
        `[PartitionLease] refresh p=${p}: held by ${lock.holderDeviceId}${self} until ${lock.leasedUntil}`,
      )
      this.holders.set(p, {
        deviceId: lock.holderDeviceId,
        generation: lock.generation,
        acquiredAt: lock.acquiredAt,
        leasedUntil: lock.leasedUntil,
      })
    }
    const summary = Array.from(this.holders.entries())
      .map(([p, h]) => `${p}->${h.deviceId}`)
      .join(",")
    console.debug(
      `[PartitionLease] refresh: live holders={${summary}} self=${this.opts.deviceId}`,
    )
  }

  /**
   * Merge live holders detected from per-device PRESENCE BEACONS (the intent
   * SOCs holders re-publish each refresh) into `holders`. Unlike the static
   * lock SOC, these live at fresh per-epoch addresses, so reading them forces a
   * network retrieval that works on a gateway that 404s the static address —
   * this is what lets a joiner detect an existing holder. Call AFTER
   * `refreshFromSwarm` (union, not replace): either channel showing a live
   * foreign holder marks the partition held. No-op without known rivals.
   */
  async refreshHoldersFromPresence(partitionCount: number): Promise<void> {
    const now = this.now()
    const rivals = (this.opts.knownDeviceIds?.() ?? []).filter(
      (id) => id !== this.opts.deviceId,
    )
    if (rivals.length === 0) return

    const currentBucket = intentEpochBucket(now)
    const buckets = [currentBucket, currentBucket - 1]

    const results = await Promise.all(
      Array.from({ length: partitionCount }).flatMap((_unused, p) =>
        rivals.flatMap((deviceId) =>
          buckets.map(async (bucket) => ({
            partition: p,
            deviceId,
            bucket,
            intent: await readPartitionIntent({
              bee: this.opts.bee,
              backupSigner: this.opts.backupSigner,
              swarmEncryptionKey: this.opts.swarmEncryptionKey,
              partition: p,
              deviceId,
              epochBucket: bucket,
              timeoutMs: this.opts.intentReadTimeoutMs,
            }),
          })),
        ),
      ),
    )

    for (const { partition, deviceId, bucket, intent } of results) {
      if (!intent) continue
      // An explicit release sentinel on the lock authoritatively freed this
      // partition; ignore the just-released holder's lingering PRESENCE beacon
      // (still within TTL/grace) so a peer can take over immediately — mirrors
      // `refreshHoldersFromOccupancy`. Without this, the per-device presence
      // channel re-marks a released partition held for up to a full lease TTL,
      // defeating the fast-takeover the release sentinel exists to enable.
      if (this.releasedPartitions.has(partition)) continue
      // A holder beacon carries `leasedUntil`; a pre-claim intent (the
      // symmetric-race announce) does NOT. Only a beacon means "this partition
      // is HELD" — a bare intent is a contender, left for the intent round to
      // resolve, so it must NOT mark the partition held here. The grace covers a
      // live holder whose freshest beacon hasn't propagated (see
      // INTENT_LIVENESS_GRACE_MS).
      if (
        intent.leasedUntil === undefined ||
        intent.leasedUntil <= now - INTENT_LIVENESS_GRACE_MS
      )
        continue
      const leasedUntil = intent.leasedUntil

      const existing = this.holders.get(partition)
      // Keep a self-claim (from the lock SOC) — we hold it; don't let a foreign
      // beacon shadow it. Otherwise record/refresh the foreign holder.
      if (existing && existing.deviceId === this.opts.deviceId) continue
      if (!existing || leasedUntil > existing.leasedUntil) {
        this.holders.set(partition, {
          deviceId,
          generation: intent.generation,
          acquiredAt: existing?.acquiredAt ?? 0,
          leasedUntil,
        })
        console.debug(
          `[PartitionLease] presence p=${partition}: live holder ${deviceId} (bucket ${bucket}, leasedUntil ${leasedUntil})`,
        )
      }
    }
  }

  /**
   * Union in holders from the deviceId-INDEPENDENT occupancy beacons. For each
   * partition, read the current + previous epoch bucket (covering the rotation
   * boundary); a foreign beacon still in lease marks the partition held — even
   * when we don't know the holder's deviceId (the registry-lag case the per-device
   * channels miss). No-op once a self-claim is recorded for the partition.
   *
   * Liveness uses a STRICT `leasedUntil > now` (not the propagation GRACE the
   * per-device beacon uses): an actively-refreshing holder always has a current
   * beacon with `leasedUntil > now`, while a DEPARTED holder's last beacon has
   * genuinely lapsed — so a device legitimately taking over an expired slot
   * isn't falsely blocked by a lingering within-grace beacon (which the lock
   * SOC, when accurate, would already show as expired).
   */
  async refreshHoldersFromOccupancy(partitionCount: number): Promise<void> {
    const now = this.now()
    const currentBucket = intentEpochBucket(now)
    const buckets = [currentBucket, currentBucket - 1]

    const results = await Promise.all(
      Array.from({ length: partitionCount }).flatMap((_unused, p) =>
        buckets.map(async (bucket) => ({
          partition: p,
          occupancy: await readPartitionOccupancy({
            bee: this.opts.bee,
            backupSigner: this.opts.backupSigner,
            swarmEncryptionKey: this.opts.swarmEncryptionKey,
            partition: p,
            epochBucket: bucket,
            timeoutMs: this.opts.intentReadTimeoutMs,
          }),
        })),
      ),
    )

    for (const { partition, occupancy } of results) {
      if (!occupancy || occupancy.leasedUntil === undefined) continue
      if (occupancy.leasedUntil <= now) continue // genuinely expired holder
      if (occupancy.deviceId === this.opts.deviceId) continue // our own beacon
      // An explicit release sentinel on the lock authoritatively freed this
      // partition; ignore the just-released holder's lingering occupancy beacon
      // so a peer can take over immediately (the lock release is the truth here,
      // unlike a stale/expired lock which the occupancy beacon is meant to
      // override).
      if (this.releasedPartitions.has(partition)) continue
      const existing = this.holders.get(partition)
      // Don't let a foreign beacon shadow our own live self-claim.
      if (existing && existing.deviceId === this.opts.deviceId) continue
      if (!existing || occupancy.leasedUntil > existing.leasedUntil) {
        this.holders.set(partition, {
          deviceId: occupancy.deviceId,
          generation: occupancy.generation,
          acquiredAt: existing?.acquiredAt ?? 0,
          leasedUntil: occupancy.leasedUntil,
        })
        console.debug(
          `[PartitionLease] occupancy p=${partition}: live holder ${occupancy.deviceId} (leasedUntil ${occupancy.leasedUntil})`,
        )
      }
    }
  }

  /** True if `deviceId` is a live holder of any partition (post-refresh). */
  isActive(deviceId: string): boolean {
    for (const holder of this.holders.values()) {
      if (holder.deviceId === deviceId) return true
    }
    return false
  }

  /** The partition this device currently holds per the lock SOCs, else undefined. */
  heldPartition(): number | undefined {
    for (const [partition, holder] of this.holders) {
      if (holder.deviceId === this.opts.deviceId) return partition
    }
    return undefined
  }

  /**
   * Live holders observed by the last `refreshFromSwarm`, one entry per
   * partition currently held. The single read view of "who's active" — the
   * SwarmID UI renders the Devices tab from this.
   */
  getHolders(): { partition: number; deviceId: string; leasedUntil: number }[] {
    return Array.from(this.holders.entries()).map(([partition, holder]) => ({
      partition,
      deviceId: holder.deviceId,
      leasedUntil: holder.leasedUntil,
    }))
  }

  /**
   * First partition with no live holder that isn't us, else `undefined`,
   * scanning from this device's deterministic home offset
   * (`deviceHomePartition`) and wrapping. Starting from a per-device offset
   * spreads devices across slots even when none can read peers' locks (the
   * disjoint-gateway frozen-cache case); the wrap keeps full coverage so a
   * genuinely free slot is never missed. Drives candidate selection in
   * `acquire`.
   */
  private pickFreeOrExpired(partitionCount: number): number | undefined {
    const start = deviceHomePartition(this.opts.deviceId, partitionCount)
    for (let i = 0; i < partitionCount; i++) {
      const p = (start + i) % partitionCount
      const holder = this.holders.get(p)
      if (!holder || holder.deviceId === this.opts.deviceId) return p
    }
    return undefined
  }

  /**
   * Acquire a partition. Always consults the lock SOCs (via
   * `refreshFromSwarm`) — there is no local-state shortcut. Refreshes our
   * existing partition when we already hold one; otherwise claims the first
   * free / expired one. Returns read-only when every partition is held by a
   * live foreign holder.
   */
  async acquire(
    snapshot: PartitionLeaseSnapshotInputs,
  ): Promise<AcquireResult> {
    const { partitionCount } = snapshot

    // A new acquisition opens a new lease session. Drop any cached publish
    // state from a previous session — this session resumes from the partition's
    // published counter, not our stale one (a peer may have held it meanwhile).
    this.closed = false
    this.publishedReferences = undefined
    this.publishedCounter = undefined
    this.lastReferenceHex = undefined
    this.lastFullPublishEpoch = undefined

    if (partitionCount <= 1) {
      return {
        partition: undefined,
        partitionCount: 1,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: false,
      }
    }

    await this.refreshFromSwarm(partitionCount)
    // Union in holders detected via presence beacons (fresh per-epoch reads
    // that work on the gateway where the static lock SOC is unreadable). This
    // is what lets us detect a peer that ALREADY holds a partition.
    await this.refreshHoldersFromPresence(partitionCount)
    // Also union in the deviceId-INDEPENDENT occupancy beacons. Unlike the two
    // channels above (keyed on `knownDeviceIds`), this detects a live holder we
    // have NEVER heard of — the registry-lag dual-acquire where a re-claiming
    // device hasn't synced a peer yet and is blind to it on every keyed channel.
    await this.refreshHoldersFromOccupancy(partitionCount)

    // Prefer the partition we already hold; otherwise the first free/expired.
    // A re-acquire of our own partition is not a contended claim — skip the
    // intent round (which only guards taking a free/expired slot).
    const held = this.heldPartition()
    const chosenPartition = held ?? this.pickFreeOrExpired(partitionCount)
    // Why this partition was chosen — `home` is our deterministic scan start,
    // `liveHolders` the count refreshFromSwarm saw. If we pick a partition a
    // peer actually holds, that means we couldn't read its lock SOC above.
    console.debug(
      `[PartitionLease] acquire: chosen=${chosenPartition} via=${held !== undefined ? "held(re-acquire)" : "pickFreeOrExpired"} home=${deviceHomePartition(this.opts.deviceId, partitionCount)} liveHolders=${this.holders.size} partitionCount=${partitionCount}`,
    )

    if (chosenPartition === undefined) {
      // Every partition is live + foreign-held.
      return {
        partition: undefined,
        partitionCount,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: true,
      }
    }

    return this.claimPartition({
      partition: chosenPartition,
      partitionCount,
      freshClaim: held === undefined,
    })
  }

  /**
   * Read partition-state for counter seeding, then drive
   * `acquirePartitionLock` to claim + verify the partition.
   *
   * On a `lost-race` or `blocked` outcome we fall back to read-only.
   */
  private async claimPartition(args: {
    partition: number
    partitionCount: number
    /** A first-time claim of a free/expired slot (vs. a re-acquire of ours). */
    freshClaim: boolean
  }): Promise<AcquireResult> {
    const { partition, partitionCount, freshClaim } = args
    const { stamper, batchId, batchDepth } = this.requireWriteContext()

    // Cache-aware seed: pass the reference our local counter is already in
    // sync with. If the feed still points there, `readPartitionState` skips
    // the reference + counter-chunk downloads and we reuse the local counter.
    const knownReference =
      stamper instanceof UtilizationAwareStamper
        ? await stamper.getSyncedReference(partition)
        : undefined
    const stateResult = await readPartitionState(
      {
        bee: this.opts.bee,
        owner: this.opts.backupSigner.publicKey().address(),
        swarmEncryptionKey: this.opts.swarmEncryptionKey,
        batchId,
        partition,
        batchDepth,
        // Locate the pointer of a partition that's been free for a while at the
        // gone holder's last-heartbeat bucket (its `leasedUntil`), so a takeover
        // resumes at the right counter however long ago the holder stopped. A live
        // self/foreign holder's `leasedUntil` comes from `holders`; an EXPIRED or
        // RELEASED holder's (the actual takeover case — `pickFreeOrExpired` only
        // picks partitions with no live holder) comes from `lastSeenLeasedUntil`,
        // which `refreshFromSwarm` retains from the lock SOC.
        holderLeasedUntilMs:
          this.holders.get(partition)?.leasedUntil ??
          this.lastSeenLeasedUntil.get(partition),
        // If this partition's lock read was inconclusive (timed out), a
        // "no pointer found" result must fail safe rather than zero-seed.
        lockUnreadable: this.unreadableLocks.has(partition),
        // Reader half of the rendezvous — this device's clock (#385).
        nowMs: this.now(),
      },
      knownReference,
    )

    // The partition has a published resume point we failed to read. Claiming
    // anyway would mean stamping from an unknown (effectively zero) counter —
    // re-issuing used slots and evicting the partition's existing data. Fall
    // back to read-only WITHOUT writing the lock SOC; the coordinator's
    // slot-wait / next-upload acquire retries shortly.
    if (stateResult.readFailed) {
      console.debug(
        `[PartitionLease] Partition ${partition} state read failed; falling back to read-only without claiming.`,
      )
      return {
        partition: undefined,
        partitionCount,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: true,
      }
    }

    const localCounter =
      stateResult.unchanged && stamper instanceof UtilizationAwareStamper
        ? stamper.buildLeaseLocalCounter()
        : (stateResult.localCounter ?? new Uint32Array(NUM_BUCKETS))

    // The generation we will both advertise (intent round) and claim with, so
    // the round's winner binds the lock with the exact generation it announced.
    const generation: PartitionLockGeneration = {
      timestampMs: this.now(),
      tiebreaker: makeDeviceTiebreaker(this.opts.deviceId),
    }

    // Phase 2: for a fresh claim of a free/expired slot with known rivals, run
    // an intent round at a fresh per-epoch address (forces a network read that
    // bypasses the gateway's frozen lock-SOC cache). Only the round's winner
    // proceeds to bind; losers back off to read-only. See partition-intent.ts.
    const knownDeviceIds = this.opts.knownDeviceIds?.() ?? []
    const hasRival = knownDeviceIds.some((id) => id !== this.opts.deviceId)
    // Diagnostic: shows whether the intent round even runs, and on how many
    // peers. The dual-acquire failure is "freshClaim + no rival seen at acquire
    // time" (registry not yet synced) or "round ran but found nothing".
    console.debug(
      `[PartitionLease] claim p=${partition} self=${this.opts.deviceId} freshClaim=${freshClaim} knownDevices=${knownDeviceIds.length} intentRound=${freshClaim && hasRival}`,
    )
    if (freshClaim && hasRival) {
      const outcome = await resolveIntentRound({
        bee: this.opts.bee,
        stamper,
        backupSigner: this.opts.backupSigner,
        swarmEncryptionKey: this.opts.swarmEncryptionKey,
        partition,
        deviceId: this.opts.deviceId,
        generation,
        knownDeviceIds,
        now: this.now(),
        timeoutMs: this.opts.intentReadTimeoutMs,
        guardWindowMs: this.opts.intentGuardWindowMs ?? INTENT_GUARD_WINDOW_MS,
        guardPollMs: this.opts.intentGuardPollMs ?? INTENT_GUARD_POLL_MS,
        // If the chosen partition was just released, its prior holder's lingering
        // presence beacon must not lose us the round — only a claim NEWER than
        // the release watermark counts as a live holder.
        releasedGeneration: this.releasedPartitions.get(partition),
      })
      if (outcome === "lose") {
        console.debug(
          `[PartitionLease] Lost intent round for partition ${partition}; falling back to read-only.`,
        )
        return {
          partition: undefined,
          partitionCount,
          localCounter: new Uint32Array(NUM_BUCKETS),
          isReadOnly: true,
        }
      }
    }

    const lockResult = await acquirePartitionLock({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      partition,
      deviceId: this.opts.deviceId,
      ttlMs: LEASE_TTL_MS,
      guardMs: this.opts.guardMs ?? PARTITION_LOCK_GUARD_MS,
      generation,
      now: () => this.now(),
    })

    if (lockResult.outcome !== "acquired" || !lockResult.payload) {
      console.debug(
        `[PartitionLease] Lock acquire for partition ${partition} outcome=${lockResult.outcome}; falling back to read-only.`,
      )
      return {
        partition: undefined,
        partitionCount,
        localCounter: new Uint32Array(NUM_BUCKETS),
        isReadOnly: true,
      }
    }

    // Lock acquired → the caller will bind this counter, so record the feed
    // reference we just downloaded as our "synced reference" (lets the next
    // acquire skip the download). Only on a real read — never on `unchanged`
    // (already cached) or a failed read (no `referenceHex`). Also protect the
    // published state chunks' buckets from our utilisation saves.
    if (
      !stateResult.unchanged &&
      stateResult.referenceHex &&
      stamper instanceof UtilizationAwareStamper
    ) {
      await stamper.setSyncedReference(partition, stateResult.referenceHex)
      if (stateResult.stateBuckets) {
        await stamper.setProtectedStateBuckets(
          partition,
          stateResult.stateBuckets,
        )
      }
    }

    // Seed the publish baseline from the state we just resumed, so the FIRST
    // publish of this session is incremental (only the bucket the upload touches
    // + the reference chunk) instead of a full re-publish. `publishedCounter`
    // must be a COPY: bindPartition aliases `localCounter` and the stamper
    // mutates it on stamp(), which would otherwise empty the diff. When the read
    // recovered no refs (fresh account / cache-miss), these stay undefined and
    // the first publish falls back to the sparse-full path.
    //
    // SAFETY INVARIANT (why a divergent seed is safe). On the cache-hit
    // (`unchanged`) branch `publishedReferences` describes the last *acked*
    // counter (the synced reference, advanced only on a successful publish/read)
    // while `publishedCounter` = `buildLeaseLocalCounter()`, which can be AHEAD
    // if a prior publish FAILED after the local counter advanced (withWrite's
    // `finally` still flushes the bumped counter). Counters are monotonic, so
    // `publishedCounter >= synced-ref counter` always — the refs never describe a
    // value ABOVE the counter. On the first incremental publish an unchanged
    // (ahead) chunk therefore RETAINS a ref describing the acked floor, and a
    // takeover resumes at ≤ the acked high-water: it only ever reissues *unacked*
    // (content-addressed → safe) slots, never an acked one. The dangerous
    // direction — a ref reporting above the counter, which could resume PAST an
    // acked slot into reuse — cannot occur. See the "divergent seed" regression
    // test in partition-lease.integration.test.ts.
    //
    // KEYSTONE (the one upstream fact this rests on): the stamper keeps its local
    // per-partition counter monotonic and >= its synced-reference counter. Every
    // guarantee above collapses if a future change to stamper-state persistence
    // lets the local counter fall BELOW the synced ref. `writePartitionState`'s
    // incremental path carries a cheap monotonicity tripwire that fails the
    // publish loudly (rather than silently retaining a ref above the counter) if
    // that invariant is ever broken — see the assert there.
    this.publishedReferences = stateResult.references
    this.publishedCounter = localCounter.slice()
    // Mark this epoch as already full-pinned so the FIRST publish of the session
    // stays incremental against the resumed refs (the cheap-first-publish win).
    // On the FULL-read branch every non-zero counter chunk was just downloaded,
    // so the retained refs are verified-present. On the CACHE-HIT branch only the
    // reference chunk was read (the counter chunks were not re-fetched), so a
    // retained chunk that was meanwhile evicted from the reserve is NOT detected
    // here — but that stays fail-safe: a takeover reading the missing chunk gets
    // `readFailed` (→ read-only + retry), never a zero-counter resume, and this
    // holder's own once-per-epoch full re-pin (`flushState`, below) re-uploads it
    // from local state once the epoch rolls over. Either way the re-pin bounds a
    // retained chunk's eviction exposure to ~1 epoch.
    this.lastFullPublishEpoch = intentEpochBucket(this.now())
    // Seed the heartbeat's pointer target from the state we resumed, so a holder
    // that never uploads still re-publishes the inherited resume pointer to the
    // current bucket each refresh tick (otherwise `heartbeatStatePointer` no-ops
    // until the first upload and the resume point ages out of the takeover lookup
    // span → resume-from-zero). Undefined on a genuinely fresh account (no prior
    // pointer to keep alive — the heartbeat correctly stays a no-op).
    this.lastReferenceHex = stateResult.referenceHex

    const payload = lockResult.payload
    this.self = {
      partition,
      generation: payload.generation,
      acquiredAt: payload.acquiredAt,
      leasedUntil: payload.leasedUntil,
    }
    this.holders.set(partition, {
      deviceId: this.opts.deviceId,
      generation: payload.generation,
      acquiredAt: payload.acquiredAt,
      leasedUntil: payload.leasedUntil,
    })

    // Publish presence immediately so a joiner appearing before our first
    // refresh tick still detects us (don't wait ~10s for the first heartbeat).
    await this.publishPresenceBeacon(
      partition,
      payload.generation,
      payload.leasedUntil,
    )

    return {
      partition,
      partitionCount,
      localCounter,
      isReadOnly: false,
      lockPayload: payload,
    }
  }

  /**
   * Re-run the lock protocol on the currently-held partition to bump
   * `leasedUntil`. Returns `"lost"` when we don't hold a lease (legacy mode)
   * or the lock protocol returned `blocked` / `lost-race` / `aborted`,
   * `"displaced"` when a foreign presence beacon proves a peer holds the
   * partition (the deconfliction backstop), else `"held"`. See
   * `LeaseRefreshOutcome` for how the coordinator must react to each.
   */
  async refresh(): Promise<LeaseRefreshOutcome> {
    if (!this.self) return "lost"
    const partition = this.self.partition
    const { stamper } = this.requireWriteContext()
    const lockResult = await acquirePartitionLock({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      partition,
      deviceId: this.opts.deviceId,
      ttlMs: LEASE_TTL_MS,
      guardMs: this.opts.guardMs ?? PARTITION_LOCK_GUARD_MS,
      now: () => this.now(),
      // A release closes the lease session; a refresh that overlaps it must
      // not mint a fresh ghost claim — the generation-fenced release would
      // refuse to clear it and peers would wait out the TTL.
      shouldAbort: () => this.closed,
    })
    // `release()` can complete during the guard window above and null
    // `this.self` — re-check before dereferencing it.
    if (!this.self) return "lost"
    if (lockResult.outcome !== "acquired" || !lockResult.payload) {
      console.debug(
        `[PartitionLease] Refresh on partition ${partition} returned ${lockResult.outcome}.`,
      )
      return "lost"
    }
    const payload = lockResult.payload
    this.self = {
      partition,
      generation: payload.generation,
      acquiredAt: payload.acquiredAt,
      leasedUntil: payload.leasedUntil,
    }
    // Re-publish our presence beacon so a joining device can detect us on the
    // gateway, where the static lock SOC isn't reliably retrievable. Best-effort
    // (a failed beacon self-heals next tick).
    await this.publishPresenceBeacon(
      partition,
      payload.generation,
      payload.leasedUntil,
    )

    // Deconfliction backstop: if a concurrent claim slipped past the acquire-time
    // poll-guard (propagation outran the window), two devices can briefly hold
    // the same partition. Once both beacons have propagated, the one with the
    // LATER generation yields here so the pair resolves to a single holder.
    // This is a CONFIRMED displacement (read via the fresh per-epoch beacon
    // address, which stays readable on a disjoint gateway) — reported as
    // `"displaced"` so the coordinator demotes WITHOUT re-checking the static
    // lock SOC, which we just rewrote with our own claim above and which is the
    // frozen read the beacon channel exists to bypass.
    if (
      (await this.foreignBeaconBeatsUs(partition, payload.generation)) ||
      (await this.occupancyBeaconBeatsUs(partition, payload.generation))
    ) {
      console.debug(
        `[PartitionLease] Refresh on partition ${partition}: an earlier-generation peer holds it; yielding.`,
      )
      return "displaced"
    }
    return "held"
  }

  /**
   * True if some OTHER device has a live presence beacon on `partition` whose
   * generation orders strictly before `ourGeneration` (i.e. it claimed first).
   * Reads the current+previous epoch bucket for each known rival (fresh
   * addresses → gateway-retrievable). No rivals known → false.
   */
  private async foreignBeaconBeatsUs(
    partition: number,
    ourGeneration: PartitionLockGeneration,
  ): Promise<boolean> {
    const now = this.now()
    const rivals = (this.opts.knownDeviceIds?.() ?? []).filter(
      (id) => id !== this.opts.deviceId,
    )
    if (rivals.length === 0) return false
    const currentBucket = intentEpochBucket(now)
    const results = await Promise.all(
      rivals.flatMap((deviceId) =>
        [currentBucket, currentBucket - 1].map((bucket) =>
          readPartitionIntent({
            bee: this.opts.bee,
            backupSigner: this.opts.backupSigner,
            swarmEncryptionKey: this.opts.swarmEncryptionKey,
            partition,
            deviceId,
            epochBucket: bucket,
            timeoutMs: this.opts.intentReadTimeoutMs,
          }),
        ),
      ),
    )
    return results.some(
      (intent) =>
        intent?.leasedUntil !== undefined &&
        intent.leasedUntil > now - INTENT_LIVENESS_GRACE_MS &&
        compareGenerations(intent.generation, ourGeneration) < 0 &&
        this.beaconOutranksRelease(partition, intent.generation),
    )
  }

  /**
   * Whether a foreign live beacon represents a real claim rather than the
   * just-released holder's stale GHOST. A beacon outranks the partition's
   * observed release only if its generation is STRICTLY NEWER than the released
   * claim's (the watermark recorded by `refreshFromSwarm`). At or below the
   * watermark the beacon is the lingering presence/occupancy SOC the releaser
   * left behind — still within its lease TTL at a live per-epoch address, but no
   * longer a claim — so it must not block/displace a peer taking over the freed
   * partition. A genuine post-release claimant always has a newer generation
   * (current timestamp ≫ the old watermark under the clock-sync assumption), so
   * it is still honored — no dual-acquire regression. No watermark → outranks.
   */
  private beaconOutranksRelease(
    partition: number,
    beaconGeneration: PartitionLockGeneration,
  ): boolean {
    const releasedGen = this.releasedPartitions.get(partition)
    return (
      releasedGen === undefined ||
      compareGenerations(beaconGeneration, releasedGen) > 0
    )
  }

  /**
   * Like `foreignBeaconBeatsUs`, but reads the deviceId-INDEPENDENT occupancy
   * beacon (current + previous epoch bucket). This resolves a dual-acquire with a
   * peer that is NOT in `knownDeviceIds` — e.g. a live device pruned from the
   * rival set by `activeDeviceIds` (its `lastSignedInAt` aged past
   * `KNOWN_DEVICE_MAX_AGE_MS` even though it never signed out). Without this,
   * `refresh()`'s deviceId-keyed `foreignBeaconBeatsUs` is blind to that peer and
   * a symmetric fresh-claim dual-acquire would stay sticky.
   *
   * The occupancy SOC is a single shared address per (partition, epoch), so two
   * holders clobber each other's writes; only the later-generation loser yields,
   * and it converges within a few refresh ticks (whenever it reads a tick where
   * the earlier-generation winner wrote last). True when a foreign live occupancy
   * beacon orders strictly before our generation.
   */
  private async occupancyBeaconBeatsUs(
    partition: number,
    ourGeneration: PartitionLockGeneration,
  ): Promise<boolean> {
    const now = this.now()
    const currentBucket = intentEpochBucket(now)
    const results = await Promise.all(
      [currentBucket, currentBucket - 1].map((bucket) =>
        readPartitionOccupancy({
          bee: this.opts.bee,
          backupSigner: this.opts.backupSigner,
          swarmEncryptionKey: this.opts.swarmEncryptionKey,
          partition,
          epochBucket: bucket,
          timeoutMs: this.opts.intentReadTimeoutMs,
        }),
      ),
    )
    return results.some(
      (occupancy) =>
        occupancy !== undefined &&
        occupancy.deviceId !== this.opts.deviceId &&
        occupancy.leasedUntil !== undefined &&
        occupancy.leasedUntil > now - INTENT_LIVENESS_GRACE_MS &&
        compareGenerations(occupancy.generation, ourGeneration) < 0 &&
        this.beaconOutranksRelease(partition, occupancy.generation),
    )
  }

  /**
   * Re-publish this device's holder presence beacon for `partition` at the
   * CURRENT epoch (the intent SOC, with `leasedUntil` set). A joiner's
   * `refreshHoldersFromPresence` reads this at a fresh per-epoch address (forced
   * network retrieval), which works on a gateway that 404s the static lock SOC.
   * Best-effort — never fails the refresh; the ~10s refresh cadence <
   * INTENT_EPOCH_MS (30s) keeps the current bucket continuously populated for a
   * live holder.
   *
   * Published UNCONDITIONALLY while holding (this method is only reached for a
   * K>1 partition). It must NOT be gated on knowing a rival: a device that
   * created the account hasn't synced its peer into the registry yet, so a
   * rival-gated beacon would leave that holder invisible and a peer who DOES
   * know it would find no beacon and dual-acquire the same partition.
   */
  private async publishPresenceBeacon(
    partition: number,
    generation: PartitionLockGeneration,
    leasedUntil: number,
  ): Promise<void> {
    const { stamper } = this.requireWriteContext()
    const epochBucket = intentEpochBucket(this.now())
    try {
      // Per-device beacon (generation tiebreak / displacement backstop) AND the
      // deviceId-independent occupancy beacon (lets a peer that doesn't know us
      // detect we hold this partition). Both unconditional while holding.
      await writePartitionIntent({
        bee: this.opts.bee,
        stamper,
        backupSigner: this.opts.backupSigner,
        swarmEncryptionKey: this.opts.swarmEncryptionKey,
        partition,
        deviceId: this.opts.deviceId,
        epochBucket,
        generation,
        leasedUntil,
      })
      await writePartitionOccupancy({
        bee: this.opts.bee,
        stamper,
        backupSigner: this.opts.backupSigner,
        swarmEncryptionKey: this.opts.swarmEncryptionKey,
        partition,
        deviceId: this.opts.deviceId,
        epochBucket,
        generation,
        leasedUntil,
      })
    } catch (error) {
      console.debug(
        `[PartitionLease] presence beacon publish failed for p=${partition} (self-heals next tick):`,
        error,
      )
    }
  }

  /**
   * Publish the final local counter on the partition-state feed, then
   * write the generation-fenced release sentinel to the lock SOC so peers
   * see an immediate, authoritative release. The sentinel carries the
   * generation of the claim being released (captured BEFORE the slow
   * publish) and is skipped entirely when the lock no longer carries that
   * claim — a detached release outliving a same-device re-acquire must not
   * clobber the successor's claim (#349). No-op when no lease is held.
   */
  async release(localCounter: Uint32Array): Promise<void> {
    if (!this.self) return
    // Capture the claim being released before anything slow happens: the
    // sentinel fences exactly this claim, and `closed` stops a concurrent
    // refresh from minting a newer ghost claim mid-release.
    const { partition, generation, acquiredAt } = this.self
    this.closed = true
    const { stamper } = this.requireWriteContext()

    await this.flushState(partition, localCounter)

    await releasePartitionLock({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      partition,
      deviceId: this.opts.deviceId,
      releasedGeneration: generation,
      acquiredAt,
      now: () => this.now(),
    })

    // The lease session is over on BOTH outcomes — "skipped" means a
    // successor or peer owns the lock now, which releases us just the same.
    this.self = undefined
    this.holders.delete(partition)
  }

  /**
   * Publish the held partition's counter on the partition-state feed WITHOUT
   * releasing the lock — the commit point that makes an upload's slots durable
   * before its promise resolves (ack-after-publish). The new holder on takeover
   * resumes at exactly this counter, so an un-published (un-acked) in-flight
   * write is safe to overwrite while every acked write is preserved. No-op when
   * no lease is held. Same reserved-slot publish as `release()`, so it is safe
   * through a still-bound stamper.
   */
  async publishState(localCounter: Uint32Array): Promise<void> {
    if (!this.self) return
    await this.flushState(this.self.partition, localCounter)
  }

  /**
   * Publish `localCounter` on the partition-state feed and record it as our
   * synced reference + protected buckets. Shared by `release()` (final flush)
   * and `publishState()` (per-upload commit). Protecting the publish's buckets
   * stops a later utilisation save from overstamping (evicting) the resume
   * point from the reserve.
   */
  private async flushState(
    partition: number,
    localCounter: Uint32Array,
    opts?: { forceFull?: boolean },
  ): Promise<void> {
    const { stamper, batchId, batchDepth } = this.requireWriteContext()
    // Force a FULL (non-incremental) publish once per epoch: incremental
    // publishes leave unchanged chunks pinned across epochs, where a later
    // epoch's rotating pointer/beacon SOC (same reserved slot) can evict one and
    // the incremental path never re-uploads it. Re-pinning every epoch bounds a
    // retained chunk's exposure to ~1 epoch and self-heals any eviction (the
    // full publish re-uploads every non-zero chunk clear of the current beacons).
    // `opts.forceFull` additionally forces it off-epoch: the idle refresh-tick
    // `heartbeatStatePointer` asks for it the moment it DETECTS a retained-chunk
    // collision with this epoch's own pointer/beacon bucket, so the eviction is
    // repaired the same tick rather than waiting for the next upload/epoch.
    const currentEpoch = intentEpochBucket(this.now())
    const forceFullRepin =
      opts?.forceFull === true || currentEpoch !== this.lastFullPublishEpoch
    const published = await writePartitionState({
      bee: this.opts.bee,
      stamper,
      batchId,
      batchDepth,
      partition,
      localCounter,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      // Incremental inputs from this session's last publish (undefined on the
      // first → full publish, which seeds them). Nulled once per epoch to force a
      // full re-pin (see `lastFullPublishEpoch`).
      previousReferences: forceFullRepin ? undefined : this.publishedReferences,
      previousCounter: forceFullRepin ? undefined : this.publishedCounter,
      // Lets the publish also avoid this device's intent-beacon buckets (the
      // refresh tick re-writes them off-lock at the same reserved slot).
      deviceId: this.opts.deviceId,
      // Anchor the rendezvous addresses to this device's clock (#385): same
      // clock as the collision detector and lease validity; `Date.now()` in prod.
      nowMs: this.now(),
    })
    if (forceFullRepin) this.lastFullPublishEpoch = currentEpoch
    this.publishedReferences = published.references
    this.publishedCounter = published.publishedCounter
    this.lastReferenceHex = published.referenceHex
    if (stamper instanceof UtilizationAwareStamper) {
      await stamper.setSyncedReference(partition, published.referenceHex)
      await stamper.setProtectedStateBuckets(partition, published.stateBuckets)
    }
  }

  /**
   * Seed the heartbeat's pointer target (`lastReferenceHex`) without reading
   * partition-state. Used by the coordinator's cached-lease re-adopt fast path
   * (`adoptIfLive`), which binds from local state and never runs
   * `claimPartition` — where the cold acquire path seeds this. Without it a
   * reloaded holder that re-adopts its lease and then stays idle never
   * heartbeats the inherited resume pointer forward, so it ages out of the
   * takeover lookup span (resume-from-zero → re-issue acked slots). The caller
   * passes the partition's persisted synced reference
   * (`UtilizationAwareStamper.getSyncedReference`); `undefined` (fresh partition)
   * keeps the heartbeat a no-op.
   */
  seedReferenceHex(referenceHex: string | undefined): void {
    this.lastReferenceHex = referenceHex
  }

  /**
   * Re-write the state pointer to the CURRENT rotating bucket without
   * re-uploading the counter — the refresh-tick heartbeat. Keeps a fresh pointer
   * in the current bucket so a taking-over device finds the resume point even
   * after this holder has been idle (no uploads) for a while. No-op until the
   * first publish of the session has produced a reference to point at.
   *
   * COLLISION SELF-HEAL: when this epoch's own rotating pointer/beacon buckets
   * (or the constant lock-SOC bucket) now coincide with a RETAINED counter/
   * reference chunk — the ~1/65536-per-epoch case an incremental publish left
   * unrefreshed — a bare pointer write here would OVERSTAMP (evict) that chunk at
   * their shared reserved slot. `retainedChunksCollideThisEpoch` detects it (CPU
   * only, no network on the ~99.998% clear path) and, given the live counter,
   * relocates via a forced full re-pin (`flushState`) so the eviction is repaired
   * the same tick instead of waiting for the next upload. Without a counter to
   * re-pin (or on a SOC-vs-SOC collision, where neither party is movable) it
   * falls through to the plain pointer write — still fail-safe: the collision is
   * bounded to one epoch (the rotating addresses separate next epoch) and a
   * takeover reading a missing chunk gets `readFailed` (→ read-only + retry),
   * never a zero-counter resume that would re-issue acked slots.
   */
  async heartbeatStatePointer(localCounter?: Uint32Array): Promise<void> {
    if (!this.self || this.lastReferenceHex === undefined) return
    const { stamper, batchId } = this.requireWriteContext()
    if (
      localCounter !== undefined &&
      this.retainedChunksCollideThisEpoch(this.self.partition)
    ) {
      // Relocate the retained chunks clear of this epoch's reserved-slot writers.
      // `flushState({ forceFull: true })` re-pins every non-zero chunk (avoiding
      // the current epoch's pointer/beacon buckets) AND republishes the pointer,
      // so it subsumes the heartbeat's pointer write.
      await this.flushState(this.self.partition, localCounter, {
        forceFull: true,
      })
      return
    }
    await writeStatePointer({
      bee: this.opts.bee,
      stamper,
      backupSigner: this.opts.backupSigner,
      swarmEncryptionKey: this.opts.swarmEncryptionKey,
      batchId,
      partition: this.self.partition,
      referenceHex: this.lastReferenceHex,
      nowMs: this.now(),
    })
  }

  /**
   * True when a RETAINED published state chunk now shares a bucket with one of
   * THIS device's own reserved-slot writers for the current epoch — the rotating
   * state-pointer, the deviceId-independent occupancy beacon, this device's
   * intent beacon, or the constant lock SOC. All land at `slot = partition`, so a
   * shared bucket means one overstamps (evicts) the other. Computed from
   * `this.now()`-derived addresses — the one rendezvous clock shared by
   * `writePartitionState` (via `nowMs`) and the reader (#385), = `Date.now()` in
   * production — so a heartbeat detects exactly the collision its own write would
   * cause.
   *
   * The retained set is EVERY non-zero counter chunk (`publishedReferences`) AND
   * the reference chunk itself (`lastReferenceHex`) — the latter isn't in
   * `publishedReferences` but sits at the same reserved slot and is the very
   * chunk the pointer points at, so evicting it dangles the pointer just as
   * badly. (This is the full `stateBuckets` set the publish protects.) A peer's
   * intent beacon can't be computed here (its deviceId / address is unknown) —
   * that residual stays fail-safe (§12).
   */
  private retainedChunksCollideThisEpoch(partition: number): boolean {
    if (this.publishedReferences === undefined) return false
    const owner = this.opts.backupSigner.publicKey().address()
    const { batchId } = this.requireWriteContext()
    // `this.now()` — one clock for the whole rendezvous path (#385): the beacon/
    // heartbeat writes this guards, the publish it triggers (`writePartitionState`
    // via `nowMs`), and the reader all derive their buckets from this same clock.
    const nowMs = this.now()
    const epoch = intentEpochBucket(nowMs)
    // This device's own reserved-slot writers for the current epoch.
    const fixed = new Set<number>([
      lockSocBucket(partition, owner),
      toBucket(statePointerAddress(batchId, partition, owner, nowMs)),
      toBucket(partitionOccupancyAddress(partition, epoch, owner)),
      toBucket(intentSocAddress(partition, this.opts.deviceId, epoch, owner)),
    ])
    // Retained chunks a rotating writer above could evict: the non-zero counter
    // chunks + the reference chunk (its bucket isn't in `publishedReferences`).
    for (const ref of this.publishedReferences) {
      if (!isZeroRef(ref) && fixed.has(toBucket(ref.slice(0, 32)))) return true
    }
    if (this.lastReferenceHex !== undefined) {
      const refChunkAddr = new Reference(this.lastReferenceHex)
        .toUint8Array()
        .slice(0, 32)
      if (fixed.has(toBucket(refChunkAddr))) return true
    }
    return false
  }

  /** Current partition (undefined when not holding a lease). */
  get currentPartition(): number | undefined {
    return this.self?.partition
  }

  /** Wall-clock ms this device's lease is valid until (undefined when none). */
  get leasedUntil(): number | undefined {
    return this.self?.leasedUntil
  }

  /**
   * Advance the locally-held lease's `leasedUntil` to `now + ttlMs` without
   * any Swarm write. The caller bumps this every refresh tick as a
   * "this device is alive" heartbeat, so the persisted cache stays fresh
   * even when the Swarm lock-SOC write is transiently failing. No-op when no
   * lease is held. (The cross-device lock SOC is refreshed separately by
   * `refresh()`; this only touches local state.)
   */
  bumpLocalLease(ttlMs: number): void {
    if (!this.self) return
    this.self = { ...this.self, leasedUntil: this.now() + ttlMs }
  }

  /**
   * Re-adopt a still-valid `self` from the persisted cache (after `hydrate`)
   * without any Swarm round-trip. Returns the held partition when the cached
   * lease is still within its TTL, else `undefined` (caller falls back to the
   * cold `acquire()` lock-SOC scan). On adoption it bumps `leasedUntil` and
   * mirrors `self` into `holders` so `getHolders()`/`heldPartition()` agree.
   *
   * This is what lets a reload keep the lease: the fresh page reconstructs the
   * binding from local state alone, surviving transient lock-SOC read/write
   * failures. The next `refresh()` reconciles with Swarm.
   */
  adoptIfLive(): number | undefined {
    if (!this.self || this.self.leasedUntil <= this.now()) return undefined
    this.self = { ...this.self, leasedUntil: this.now() + LEASE_TTL_MS }
    this.holders.set(this.self.partition, {
      deviceId: this.opts.deviceId,
      generation: this.self.generation,
      acquiredAt: this.self.acquiredAt,
      leasedUntil: this.self.leasedUntil,
    })
    return this.self.partition
  }

  /**
   * Serialise the lease state for the local persistence cache. The cache is
   * a fast hint only — callers re-validate `self` against the lock SOC
   * (`refresh()` / `acquire()`) before trusting it.
   */
  serialize(): PartitionLeaseStateSnapshot {
    return {
      deviceId: this.opts.deviceId,
      batchId: this.opts.batchId?.toHex() ?? "",
      self: this.self,
    }
  }

  /**
   * Seed `self` from a persisted cache snapshot. No Swarm activity — the
   * next `refresh()`/`acquire()` re-validates against the lock SOC. Ignores
   * snapshots for a different device or batch (and read-only instances,
   * which have no batch).
   */
  hydrate(snapshot: PartitionLeaseStateSnapshot): void {
    if (snapshot.deviceId !== this.opts.deviceId) return
    if (!this.opts.batchId || snapshot.batchId !== this.opts.batchId.toHex()) {
      return
    }
    this.self = snapshot.self
  }

  /**
   * Assert the write context (stamper + batch) is present. Throws on a
   * read-only instance — acquire / refresh / release require it.
   */
  private requireWriteContext(): {
    stamper: Stamper
    batchId: BatchId
    batchDepth: number
  } {
    if (
      !this.opts.stamper ||
      !this.opts.batchId ||
      this.opts.batchDepth === undefined
    ) {
      throw new Error(
        "PartitionLease: write operation requires stamper + batchId + batchDepth (read-only instance)",
      )
    }
    return {
      stamper: this.opts.stamper,
      batchId: this.opts.batchId,
      batchDepth: this.opts.batchDepth,
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }
}
