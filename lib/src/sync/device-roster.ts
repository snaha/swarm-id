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
import { withTimeout } from "../utils/promise"
import { isNotFoundError } from "../utils/bee-error"
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

// How many indices to probe past a KNOWN roster length to detect new appends
// (#400). Absent-slot probes are the expensive kind (Bee has no fast
// authoritative 404), so once a scan has proven the roster reaches N we only
// need a short lookahead — a transient 404 here can at worst delay discovering
// a BRAND-NEW device until the next fold (minutes), never drop a known one.
// Cold scans (no memo) keep the full ROSTER_SCAN_WINDOW stop margin.
const ROSTER_TAIL_PROBES = 2

/**
 * Known roster length per `accountId:owner` — a monotonic LOWER bound learned
 * from previous scans/appends (#400). The roster is append-only, so a once-seen
 * length can never overshoot; it must also never shrink (a stale endpoint's
 * truncated read must not poison later scans). Mirrored to localStorage when
 * available so a page reload's first fold is warm too; in Node (tests, CLI) the
 * mirror self-disables and only the in-memory memo applies.
 */
const knownRosterLength = new Map<string, number>()

const ROSTER_LENGTH_STORAGE_PREFIX = "swarm-id-roster-len"

function rosterMemoKey(accountId: string, owner: EthAddress): string {
  return `${accountId}:${owner.toHex()}`
}

function getKnownRosterLength(key: string): number {
  const cached = knownRosterLength.get(key)
  if (cached !== undefined) return cached
  if (typeof localStorage === "undefined") return 0
  let raw: string | null
  try {
    raw = localStorage.getItem(`${ROSTER_LENGTH_STORAGE_PREFIX}:${key}`)
  } catch {
    return 0
  }
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  const length =
    Number.isInteger(parsed) && parsed > 0
      ? Math.min(parsed, MAX_ROSTER_SCAN)
      : 0
  knownRosterLength.set(key, length)
  return length
}

function bumpKnownRosterLength(key: string, length: number): void {
  const capped = Math.min(length, MAX_ROSTER_SCAN)
  if (capped <= getKnownRosterLength(key)) return
  knownRosterLength.set(key, capped)
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(`${ROSTER_LENGTH_STORAGE_PREFIX}:${key}`, `${capped}`)
  } catch {
    // Quota/permission failure only costs the cross-reload warm-up.
  }
}

/** Test-only: forget every memoised roster length (in-memory module state). */
export function resetRosterScanCache(): void {
  knownRosterLength.clear()
}

// Per-read cap so an empty/unreachable slot on a slow gateway fails fast instead
// of hanging on peer-exhaustion. A present slot retrieves well under this.
// Matches the epoch finder's bound. An inconclusive read (timeout / 5xx /
// network) is NOT a confirmed empty slot: `readRosterEntry` surfaces it as
// `ROSTER_READ_INCONCLUSIVE` so `readRoster` retries it once at the stop boundary
// rather than mistaking it for end-of-feed and truncating the roster.
const ROSTER_READ_TIMEOUT_MS = SYNC_READ_TIMEOUT_MS

/**
 * Sentinel for a roster slot whose read was INCONCLUSIVE — a timeout, a 5xx, or
 * a network error, as opposed to a clean 404 (`undefined`, a genuinely empty
 * slot). An inconclusive read may hide a live device the gateway just couldn't
 * return, so the scan must not treat it as end-of-feed. Only Bee's `/soc` 404
 * confirms a slot is empty.
 */
const ROSTER_READ_INCONCLUSIVE = Symbol("roster-read-inconclusive")
type RosterReadResult = Device | undefined | typeof ROSTER_READ_INCONCLUSIVE

/** Thrown by {@link readRoster} when it cannot distinguish an empty roster from
 *  an outage (index 0 stays inconclusive after the retry, nothing folded).
 *  Callers must NOT treat this as "no devices" — see {@link ensureInRoster}. */
export class RosterScanInconclusiveError extends Error {
  constructor() {
    super("roster scan inconclusive: cannot confirm the roster is empty")
    this.name = "RosterScanInconclusiveError"
  }
}

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
 * when present, `undefined` for a clean 404 / garbage blob (a confirmed-empty
 * slot — the scan's stop signal), or {@link ROSTER_READ_INCONCLUSIVE} when the
 * read was inconclusive (timeout / 5xx / network — the slot may hold a live
 * device the gateway couldn't return, so the scan must not stop on it).
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
    // Bee's `/soc` returns a clean 404 for a genuinely-absent slot (end-of-feed);
    // a timeout / 5xx / network error is inconclusive (retried at the stop
    // boundary) — NOT a confirmed empty slot.
    return isNotFoundError(error) ? undefined : ROSTER_READ_INCONCLUSIVE
  }
  // Split the blob download from the parse: a download failure is a read outcome
  // (404 = empty, else = inconclusive), whereas a parse failure is a genuinely
  // garbage blob (the SOC resolved) — a skippable hole `readRoster` folds around.
  let data: Uint8Array
  try {
    data = await withTimeout(
      downloadDataWithChunkAPI(opts.bee, new Reference(refBytes).toHex()),
      ROSTER_READ_TIMEOUT_MS,
      "roster read timed out",
    )
  } catch (error) {
    return isNotFoundError(error) ? undefined : ROSTER_READ_INCONCLUSIVE
  }
  try {
    return DeviceSchemaV1.parse(JSON.parse(new TextDecoder().decode(data)))
  } catch {
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
  const memoKey = rosterMemoKey(opts.accountId, opts.owner)
  const known = getKnownRosterLength(memoKey)
  let devices: Device[] = []
  // One past the highest index seen present in THIS scan — feeds the memo.
  let scanEnd = 0
  // Scan in parallel windows. Appends are contiguous (the same-index race
  // re-adds at the new tail, never leaving a permanent hole), so no real entry
  // lives past the true end. A hole *inside* an otherwise-present window is
  // therefore a transient read failure — the exact caching-gateway failure this
  // roster exists to survive — so we skip it and keep folding later entries
  // rather than truncating every device after it. Only a window with no present
  // entry means we may have scanned past the end of the feed.
  //
  // Window sizing (#400): the memoised known range [0..known) is read as ONE
  // parallel window (all expected hits — cheap), and past it only
  // ROSTER_TAIL_PROBES slots are probed to detect new appends. With no memo the
  // full ROSTER_SCAN_WINDOW stop margin applies, so a cold scan (restore,
  // first-ever fold) is exactly as conservative as before.
  for (let base = 0; base < MAX_ROSTER_SCAN; ) {
    const width =
      base < known
        ? known - base
        : Math.min(
            known > 0 ? ROSTER_TAIL_PROBES : ROSTER_SCAN_WINDOW,
            MAX_ROSTER_SCAN - base,
          )
    const indices = Array.from({ length: width }, (_, i) => BigInt(base + i))
    let entries = await Promise.all(
      indices.map((index) =>
        readRosterEntry({ bee: opts.bee, topic, owner: opts.owner, index }),
      ),
    )
    // A window with no present entry is a stop candidate — but an inconclusive
    // read (timeout / 5xx) may have hidden a live device. Retry just the
    // inconclusive slots ONCE before concluding end-of-feed, so a transiently
    // flaky tail window doesn't truncate the roster. Bounded to one extra partial
    // read; a still-inconclusive slot reconciles on the next sync.
    if (
      !entries.some(isDevice) &&
      entries.some((entry) => entry === ROSTER_READ_INCONCLUSIVE)
    ) {
      entries = await Promise.all(
        indices.map((index, i) =>
          entries[i] === ROSTER_READ_INCONCLUSIVE
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
    entries.forEach((entry, i) => {
      if (isDevice(entry)) {
        devices = mergeDevicesList(devices, [entry])
        scanEnd = base + i + 1
      }
    })
    // Stop on a window with no present entry. If that window is still
    // inconclusive after the retry AND we have folded nothing, we cannot tell an
    // empty roster from an outage — surface it rather than lie "[] = no devices",
    // which a caller could act on and clobber. A truncated but non-empty read is
    // the existing bounded behaviour (reconciles next sync).
    if (!entries.some(isDevice)) {
      if (
        devices.length === 0 &&
        entries.some((entry) => entry === ROSTER_READ_INCONCLUSIVE)
      ) {
        throw new RosterScanInconclusiveError()
      }
      break
    }
    base += width
  }
  if (devices.length > 0) bumpKnownRosterLength(memoKey, scanEnd)
  return devices
}

/** Narrow a roster read to a present device (not a miss or an inconclusive read). */
function isDevice(entry: RosterReadResult): entry is Device {
  return entry !== undefined && entry !== ROSTER_READ_INCONCLUSIVE
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
  // Our own append proves the roster now reaches next+1 — warm the scan memo.
  bumpKnownRosterLength(
    rosterMemoKey(opts.accountId, opts.owner),
    Number(next) + 1,
  )
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
  // If the roster read is inconclusive we cannot tell "device absent" from "read
  // failed" — skip rather than append on a guess (an append would compute its
  // index against the same failing feed and could clobber a peer's entry).
  let roster: Device[]
  try {
    roster = await readRoster({
      bee: opts.bee,
      accountId: opts.accountId,
      owner: opts.owner,
    })
  } catch {
    return
  }
  const existing = roster.find((d) => d.deviceId === opts.device.deviceId)

  const upToDate =
    existing !== undefined &&
    Boolean(existing.removedAt) === Boolean(opts.device.removedAt)
  if (upToDate) return

  await appendToRoster(opts)
}
