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
import { mergeDevicesList } from "./merge-snapshot"

export const ROSTER_TOPIC_PREFIX = "swarm-id-roster-v1"

// Safety cap on a roster scan so a corrupt feed can't loop forever. Far above
// any realistic device × re-announce count for one account.
const MAX_ROSTER_SCAN = 256

// How many roster indices to probe in parallel per round. The roster is small
// and contiguous, so one window of this size usually resolves the whole scan in
// a single round-trip instead of K+1 serial ones.
const ROSTER_SCAN_WINDOW = 16

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
 * Read one roster entry (the device record) at `index`, or `undefined` when the
 * slot is empty/unreachable (the scan's stop signal).
 */
async function readRosterEntry(opts: {
  bee: Bee
  topic: Topic
  owner: EthAddress
  index: bigint
}): Promise<Device | undefined> {
  const identifier = rosterIdentifier(opts.topic, opts.index)
  let refBytes: Uint8Array
  try {
    const soc = await opts.bee.makeSOCReader(opts.owner).download(identifier)
    refBytes = soc.payload.toUint8Array()
  } catch {
    return undefined // empty slot → end of feed
  }
  try {
    const data = await downloadDataWithChunkAPI(
      opts.bee,
      new Reference(refBytes).toHex(),
    )
    return DeviceSchemaV1.parse(JSON.parse(new TextDecoder().decode(data)))
  } catch {
    // Reachable SOC but unretrievable/garbage blob — skip this entry, keep going
    // is unsafe (we can't advance past a gap), so treat as end. Rare.
    return undefined
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
  // rather than truncating every device after it. Only a FULLY empty window
  // means we have scanned past the end of the feed.
  for (let base = 0; base < MAX_ROSTER_SCAN; base += ROSTER_SCAN_WINDOW) {
    const indices = Array.from(
      { length: Math.min(ROSTER_SCAN_WINDOW, MAX_ROSTER_SCAN - base) },
      (_, i) => BigInt(base + i),
    )
    const entries = await Promise.all(
      indices.map((index) =>
        readRosterEntry({ bee: opts.bee, topic, owner: opts.owner, index }),
      ),
    )
    for (const entry of entries) {
      if (entry) devices = mergeDevicesList(devices, [entry])
    }
    if (entries.every((entry) => !entry)) break
  }
  return devices
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
