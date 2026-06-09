// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Publish account state to the shared sync feed.
 *
 * The merge/upload/verify core shared by every writer of an account's state:
 *   - `sync-account` (the SwarmID UI), and
 *   - the proxy iframe (publish-on-lease-acquisition / on a connection change).
 *
 * It does NOT take the cross-tab write lock or acquire a partition — the caller
 * runs it inside `BatchWriteCoordinator.withWrite`, which owns the lock and the
 * partition lease and hands in the `target`. This function only:
 *   1. fetches the latest remote snapshot and merges the local one onto it,
 *   2. uploads the merged snapshot, runs the caller's chunk-utilisation hook,
 *   3. writes the epoch feed, then verifies it won the slot (optimistic
 *      retry, since the shared feed is last-writer-wins), and
 *   4. probes the root chunk to confirm it's retrievable.
 */

import {
  Bee,
  EthAddress,
  PrivateKey,
  Reference,
  Topic,
} from "@ethersphere/bee-js"
import { hexToUint8Array } from "../utils/key-derivation"
import { AsyncEpochFinder, BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { serializeAccountState, deserializeAccountState } from "./serialization"
import { mergeSnapshotWithRemote } from "./merge-snapshot"
import type { AccountStateSnapshot } from "../utils/account-state-snapshot"
import type { SyncResult } from "./types"

// Topic prefix for sync feeds.
export const ACCOUNT_SYNC_TOPIC_PREFIX = "swarm-id-backup-v1:account"

// Optimistic-publish retry budget for the shared account-state feed. The feed
// update is last-writer-wins at the SOC level, so two devices publishing within
// the same epoch slot stomp each other. After writing we re-read the feed and,
// if a peer overwrote us, re-merge and republish — up to this many times.
const MAX_PUBLISH_RETRIES = 3
// Base backoff before a republish, plus a random jitter on top, so two devices
// retrying in lockstep decorrelate and stop landing in the same epoch slot.
const PUBLISH_RETRY_BACKOFF_MS = 200
const PUBLISH_RETRY_JITTER_MS = 600
// Inner timeout for the post-upload verification probe. Best-effort diagnostic
// — if it can't answer quickly we move on to "success-unverified" rather than
// letting bee-js retries consume the caller's timeout budget.
const VERIFY_PROBE_TIMEOUT_MS = 5000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Build the per-account sync-feed topic. Both readers (`AsyncEpochFinder`) and
 * the writer must agree on this.
 */
function accountSyncTopic(accountId: string): Topic {
  return Topic.fromString(`${ACCOUNT_SYNC_TOPIC_PREFIX}:${accountId}`)
}

/**
 * Read the latest on-Swarm snapshot for an account's sync feed, returning
 * `undefined` when the feed is empty or the chunks aren't retrievable.
 *
 * Best-effort: the caller treats `undefined` as "no remote, use local only".
 * Errors propagate so the caller's catch can log them.
 */
async function tryFetchLatestSnapshot(opts: {
  bee: Bee
  topic: Topic
  owner: EthAddress
}): Promise<AccountStateSnapshot | undefined> {
  const { bee, topic, owner } = opts
  // Feed SOCs are uploaded unencrypted (no encryptionKey passed to
  // updater.update below); the finder must not use one either.
  const finder = new AsyncEpochFinder(bee, topic, owner)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const refBytes = await finder.findAt(now)
  if (!refBytes) return undefined

  const reference = new Reference(refBytes)
  const data = await downloadDataWithChunkAPI(bee, reference.toHex())
  return deserializeAccountState(data)
}

export interface PublishAccountStateDeps {
  bee: Bee
  accountId: string
  /** Feed signing key (the account backup key); also derives `owner`. */
  accountKey: PrivateKey
  owner: EthAddress
  /** Hex swarm encryption key for the snapshot payload. */
  encryptionKey: string
  /** The local snapshot to merge onto the freshest remote and publish. */
  localSnapshot: AccountStateSnapshot
  /** Upload target supplied by `BatchWriteCoordinator.withWrite`. */
  target: UploadTarget
  /** Optional per-chunk utilisation hook (sync-account: handleUtilizationUpdate). */
  onChunksUploaded?: (chunkAddresses: Uint8Array[]) => Promise<void>
  /** Log prefix; defaults to "[publish]". */
  logLabel?: string
}

/**
 * Publish the account snapshot to the shared feed and confirm it. Runs inside a
 * coordinator write (lock + held partition already arranged). Returns a
 * `SyncResult` describing the outcome; never throws for the
 * overwritten/unverified cases (those are `success-unverified`).
 */
export async function publishAccountState(
  deps: PublishAccountStateDeps,
): Promise<SyncResult> {
  const {
    bee,
    accountId,
    accountKey,
    owner,
    encryptionKey,
    localSnapshot: state,
    target,
    onChunksUploaded,
  } = deps
  const label = deps.logLabel ?? "[publish]"
  const timestamp = () => new Date().toISOString()
  const topic = accountSyncTopic(accountId)
  const updater = new BasicEpochUpdater(topic, accountKey)

  // Publish once: fetch the latest remote snapshot, merge our local state onto
  // it, upload, and write the epoch feed. We always merge the *original* local
  // `state` onto the freshest remote (never our own previous merge result), so a
  // retry folds in whatever a peer published since our last attempt without
  // dropping our changes.
  const publishMerged = async (): Promise<{
    reference: string
    refBytes: Uint8Array
    feedTimestamp: bigint
    chunkAddresses: Uint8Array[]
  }> => {
    let mergedState = state
    try {
      const latestRemote = await tryFetchLatestSnapshot({ bee, topic, owner })
      if (latestRemote) {
        mergedState = mergeSnapshotWithRemote(state, latestRemote)
        console.log(
          `${label} ${timestamp()} Merged remote snapshot (remote devices=${latestRemote.metadata.devices.length}, merged devices=${mergedState.metadata.devices.length})`,
        )
      }
    } catch (err) {
      console.warn(
        `${label} ${timestamp()} Pre-write remote-snapshot fetch failed; proceeding with local state only:`,
        err,
      )
    }

    const jsonData = serializeAccountState(mergedState)

    console.log(`${label} ${timestamp()} Uploading data…`)
    const uploadResult = await uploadData(target, jsonData, {
      encryptionKey: hexToUint8Array(encryptionKey),
    })

    // chunkAddresses is always present when using encryption.
    const chunkAddresses = uploadResult.chunkAddresses ?? []
    if (chunkAddresses.length > 0 && onChunksUploaded) {
      try {
        await onChunksUploaded(chunkAddresses)
      } catch (error) {
        // Don't fail the publish if utilisation fails — continue to the feed.
        console.error(
          `${label} ${timestamp()} Chunk-utilisation hook failed:`,
          error,
        )
      }
    }

    const feedTimestamp = BigInt(Math.floor(Date.now() / 1000))
    const refBytes = new Reference(uploadResult.reference).toUint8Array()
    console.log(`${label} ${timestamp()} Updating feed…`)
    const updateResult = await updater.update(feedTimestamp, refBytes, target)
    chunkAddresses.push(updateResult.socAddress)
    return {
      reference: uploadResult.reference,
      refBytes,
      feedTimestamp,
      chunkAddresses,
    }
  }

  // Did the feed end up pointing at the reference we just wrote? A shared epoch
  // feed has no compare-and-swap: two devices publishing within the same epoch
  // slot write the same SOC address and the later signer wins by
  // last-writer-wins, silently orphaning the other's snapshot. Re-read the feed
  // and compare; only a *different* confirmed reference counts as a loss. A
  // missing/unreadable result (read-after-write lag, transient Bee error) is
  // treated as "won" so we never spuriously republish.
  const verifyWon = async (writtenRef: Uint8Array): Promise<boolean> => {
    try {
      const finder = new AsyncEpochFinder(bee, topic, owner)
      const latest = await finder.findAt(BigInt(Math.floor(Date.now() / 1000)))
      return !latest || uint8ArraysEqual(latest, writtenRef)
    } catch {
      return true
    }
  }

  // Optimistic publish with bounded verify-retry. Recreates, across devices, the
  // serialize-read-merge-write guarantee the cross-tab Web Lock gives within a
  // device. Only the loser of a collision retries; convergence holds because the
  // merge is a union — each retry folds in the peer's additions.
  let published = await publishMerged()
  let verified = await verifyWon(published.refBytes)
  for (let attempt = 0; !verified && attempt < MAX_PUBLISH_RETRIES; attempt++) {
    console.warn(
      `${label} ${timestamp()} Feed overwritten by a concurrent writer; re-merging and republishing (attempt ${attempt + 1}/${MAX_PUBLISH_RETRIES})`,
    )
    await delay(
      PUBLISH_RETRY_BACKOFF_MS +
        Math.floor(Math.random() * PUBLISH_RETRY_JITTER_MS),
    )
    published = await publishMerged()
    verified = await verifyWon(published.refBytes)
  }

  if (!verified) {
    const warning = `Account-state feed still overwritten by a concurrent writer after ${MAX_PUBLISH_RETRIES} retries; another device's publish won.`
    console.warn(`${label} ${timestamp()} ${warning}`)
    return {
      status: "success-unverified",
      reference: published.reference,
      timestamp: published.feedTimestamp,
      chunkAddresses: published.chunkAddresses,
      warning,
    }
  }

  console.log(`${label} ${timestamp()} Feed updated, verifying root chunk…`)

  // Verify the root chunk is retrievable immediately after upload. This catches
  // the case where Bee accepts the write but doesn't actually retain the data —
  // the upload reports success, the feed points at a reference, but downstream
  // restores would fail. refBytes is 32 bytes (plain) or 64 (encrypted = address
  // + key); probe the address only.
  const rootChunkAddress = published.refBytes.slice(0, 32)
  const rootChunkAddressHex = Array.from(rootChunkAddress)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  let probeTimer: ReturnType<typeof setTimeout> | undefined
  const probeTimeoutPromise = new Promise<"timeout">((resolve) => {
    probeTimer = setTimeout(() => resolve("timeout"), VERIFY_PROBE_TIMEOUT_MS)
  })
  const probePromise = bee
    .downloadChunk(rootChunkAddressHex, undefined, {
      timeout: VERIFY_PROBE_TIMEOUT_MS,
    })
    .then(() => "ok" as const)
    .catch((err) => err as Error)

  let probeOutcome: "ok" | "timeout" | Error
  try {
    probeOutcome = await Promise.race([probePromise, probeTimeoutPromise])
  } finally {
    if (probeTimer !== undefined) clearTimeout(probeTimer)
  }

  if (probeOutcome === "ok") {
    console.log(
      `${label} ${timestamp()} Verified root chunk retrievable addr=${rootChunkAddressHex}`,
    )
    return {
      status: "success",
      reference: published.reference,
      timestamp: published.feedTimestamp,
      chunkAddresses: published.chunkAddresses,
    }
  }

  const reason =
    probeOutcome === "timeout"
      ? `probe timed out after ${VERIFY_PROBE_TIMEOUT_MS}ms`
      : probeOutcome instanceof Error
        ? probeOutcome.message
        : String(probeOutcome)
  const warning = `Root chunk ${rootChunkAddressHex} not retrievable immediately after upload from ${bee.url}: ${reason}`
  console.warn(`${label} ${timestamp()} ${warning}`)
  return {
    status: "success-unverified",
    reference: published.reference,
    timestamp: published.feedTimestamp,
    chunkAddresses: published.chunkAddresses,
    warning,
  }
}
