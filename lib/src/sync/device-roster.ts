// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Device roster (Phase 3a hardening) — append-only discovery log.
 *
 * Replaces the single shared *mutable* registry doc, which a device could
 * **clobber** on a high-latency/caching gateway: it read-merge-overwrote the
 * whole doc, so a device that couldn't yet see a peer's just-written entry
 * dropped it. (See the gateway finding in the Phase 3a implementation log.)
 *
 * The roster is a **sequential append-only feed** (`swarm-id-roster-v1:<acct>`):
 * each device appends ONLY its own membership record (`Device`) at the next free
 * index. A device never overwrites a peer's slot, so concurrent announces can't
 * clobber an existing entry — the worst case is two devices racing the same
 * fresh index, where one append is lost and re-added on its next sync (existing
 * entries are untouched). Readers scan all entries and fold by `deviceId`
 * (reusing `mergeDevicesList`, so removals/resurrections converge by Phase 1
 * LWW). Account-level immutables (publicKey, createdAt, partitionCount) live on
 * the robust per-device state feed (`device-state.ts`), not here.
 *
 * Each entry is an encrypted blob (privacy parity with the old registry)
 * referenced by the sequential SOC, reusing `uploadData`/`downloadDataWithChunkAPI`.
 */

import {
  Bee,
  EthAddress,
  Identifier,
  PrivateKey,
  Reference,
  Topic,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { DeviceSchemaV1, type Device } from "../schemas"
import { hexToUint8Array } from "../utils/hex"
import {
  BasicSequentialUpdater,
  SyncSequentialFinder,
} from "../proxy/feeds/sequence"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { TimeoutError, withTimeout } from "../utils/promise"
import { SYNC_READ_TIMEOUT_MS } from "./timing-constants"
import { mergeDevicesList } from "./merge-snapshot"

export const ROSTER_TOPIC_PREFIX = "swarm-id-roster-v1"

// Safety cap on a roster scan so a corrupt feed can't loop forever. Far above
// any realistic device × re-announce count for one account.
const MAX_ROSTER_SCAN = 256

// How many roster indices to probe in parallel per round. The roster is small
// and contiguous, so one window of this size usually resolves the whole scan in
// a single round-trip instead of K+1 serial ones.
const ROSTER_SCAN_WINDOW = 16

// Per-read cap so an empty/unreachable slot on a slow gateway fails fast instead
// of hanging on peer-exhaustion. A present slot retrieves well under this.
// Matches the epoch finder's bound. A timed-out read is INCONCLUSIVE (not a
// confirmed empty slot): `readRosterEntry` surfaces it as `ROSTER_READ_TIMED_OUT`
// so `readRoster` retries it once at the stop boundary rather than mistaking it
// for end-of-feed and truncating the roster.
const ROSTER_READ_TIMEOUT_MS = SYNC_READ_TIMEOUT_MS

/**
 * Sentinel for a roster slot whose read TIMED OUT — distinct from `undefined`
 * (a clean miss / garbage blob). A timeout is inconclusive: the slot may well
 * hold a live device the slow gateway just couldn't return in time, so the scan
 * must not treat it as end-of-feed.
 */
const ROSTER_READ_TIMED_OUT = Symbol("roster-read-timed-out")
type RosterReadResult = Device | undefined | typeof ROSTER_READ_TIMED_OUT

export function rosterTopic(accountId: string): Topic {
  return Topic.fromString(`${ROSTER_TOPIC_PREFIX}:${accountId}`)
}

export function rosterIdentifier(topic: Topic, index: bigint): Identifier {
  const indexBytes = Binary.numberToUint64(index, "BE")
  return new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), indexBytes)),
  )
}

/**
 * Read one roster entry (the device record) at `index`. Returns the `Device`
 * when present, `undefined` for a clean miss / garbage blob (a confirmed-empty
 * slot — the scan's stop signal), or {@link ROSTER_READ_TIMED_OUT} when the
 * read timed out (INCONCLUSIVE — the slot may hold a live device the slow
 * gateway couldn't return, so the scan must not stop on it).
 */
async function readRosterEntry(opts: {
  bee: Bee
  topic: Topic
  owner: EthAddress
  index: bigint
}): Promise<RosterReadResult> {
  const identifier = rosterIdentifier(opts.topic, opts.index)
  let refBytes: Uint8Array
  try {
    const soc = await withTimeout(
      opts.bee.makeSOCReader(opts.owner).download(identifier),
      ROSTER_READ_TIMEOUT_MS,
      "roster read timed out",
    )
    refBytes = soc.payload.toUint8Array()
  } catch (error) {
    return error instanceof TimeoutError ? ROSTER_READ_TIMED_OUT : undefined
  }
  try {
    const data = await withTimeout(
      downloadDataWithChunkAPI(opts.bee, new Reference(refBytes).toHex()),
      ROSTER_READ_TIMEOUT_MS,
      "roster read timed out",
    )
    return DeviceSchemaV1.parse(JSON.parse(new TextDecoder().decode(data)))
  } catch (error) {
    // A timeout here is inconclusive (retried at the stop boundary). Otherwise
    // the SOC was reachable but the blob is unretrievable/garbage: return
    // `undefined` like an empty slot — `readRoster` treats a hole inside an
    // otherwise-present window as a transient (skippable) read failure (the
    // caching-gateway case this roster exists to survive) and only stops on a
    // fully-empty window.
    return error instanceof TimeoutError ? ROSTER_READ_TIMED_OUT : undefined
  }
}

/**
 * Scan the roster and fold to the latest record per `deviceId` (Phase 1
 * `mergeDevicesList`: removals/resurrections converge by LWW). Returns `[]` when
 * the feed is empty (nothing published yet).
 */
export async function readRoster(opts: {
  bee: Bee
  accountId: string
  owner: EthAddress
}): Promise<Device[]> {
  const topic = rosterTopic(opts.accountId)
  let devices: Device[] = []
  // Scan in parallel windows. Appends are contiguous (the same-index race
  // re-adds at the new tail, never leaving a permanent hole), so no real entry
  // lives past the true end. A hole *inside* an otherwise-present window is
  // therefore a transient read failure — the exact caching-gateway failure this
  // roster exists to survive — so we skip it and keep folding later entries
  // rather than truncating every device after it. Only a window with no present
  // entry means we may have scanned past the end of the feed.
  for (let base = 0; base < MAX_ROSTER_SCAN; base += ROSTER_SCAN_WINDOW) {
    const indices = Array.from(
      { length: Math.min(ROSTER_SCAN_WINDOW, MAX_ROSTER_SCAN - base) },
      (_, i) => BigInt(base + i),
    )
    let entries = await Promise.all(
      indices.map((index) =>
        readRosterEntry({ bee: opts.bee, topic, owner: opts.owner, index }),
      ),
    )
    // A window with no present entry is a stop candidate — but a timed-out read
    // is inconclusive (a slow gateway may have hidden a live device). Retry just
    // the timed-out slots ONCE before concluding end-of-feed, so a transiently
    // slow tail window doesn't truncate the roster. Bounded to one extra partial
    // read; a still-timed-out slot reconciles on the next sync.
    if (
      !entries.some(isDevice) &&
      entries.some((entry) => entry === ROSTER_READ_TIMED_OUT)
    ) {
      entries = await Promise.all(
        indices.map((index, i) =>
          entries[i] === ROSTER_READ_TIMED_OUT
            ? readRosterEntry({
                bee: opts.bee,
                topic,
                owner: opts.owner,
                index,
              })
            : entries[i],
        ),
      )
    }
    for (const entry of entries) {
      if (isDevice(entry)) devices = mergeDevicesList(devices, [entry])
    }
    // Stop on a window with no present entry (clean end-of-feed, or one whose
    // timeouts survived the retry — bounded, the slow slot reconciles later).
    if (!entries.some(isDevice)) break
  }
  return devices
}

/** Narrow a roster read to a present device (not a miss or a timeout). */
function isDevice(entry: RosterReadResult): entry is Device {
  return entry !== undefined && entry !== ROSTER_READ_TIMED_OUT
}

/** Append one device record at the next free index. Each device writes only its own. */
async function appendToRoster(opts: {
  bee: Bee
  accountKey: PrivateKey
  owner: EthAddress
  encryptionKey: string
  accountId: string
  device: Device
  target: UploadTarget
}): Promise<void> {
  const topic = rosterTopic(opts.accountId)
  const { next } = await new SyncSequentialFinder(
    opts.bee,
    topic,
    opts.owner,
  ).findAt(0n)

  if (!isStamperTarget(opts.target)) return
  const blob = new TextEncoder().encode(JSON.stringify(opts.device))
  const upload = await uploadData(opts.target, blob, {
    encryptionKey: hexToUint8Array(opts.encryptionKey),
  })
  const refBytes = new Reference(upload.reference).toUint8Array()

  const updater = new BasicSequentialUpdater(opts.bee, topic, opts.accountKey)
  updater.setState({ nextIndex: next })
  await updater.update(refBytes, opts.target.stamper)
}

function isStamperTarget(
  t: UploadTarget,
): t is UploadTarget & { mode: "stamper" } {
  return t.mode === "stamper"
}

/**
 * Ensure this device is in the roster with current membership. Appends only when
 * the device is absent or its `removedAt` state differs (a new sign-in, a
 * removal, or a resurrection) — keeping the roster a rare, append-only write.
 */
export async function ensureInRoster(opts: {
  bee: Bee
  accountKey: PrivateKey
  owner: EthAddress
  encryptionKey: string
  accountId: string
  device: Device
  target: UploadTarget
}): Promise<void> {
  const existing = (
    await readRoster({
      bee: opts.bee,
      accountId: opts.accountId,
      owner: opts.owner,
    }).catch(() => [] as Device[])
  ).find((d) => d.deviceId === opts.device.deviceId)

  const upToDate =
    existing !== undefined &&
    Boolean(existing.removedAt) === Boolean(opts.device.removedAt)
  if (upToDate) return

  await appendToRoster(opts)
}
