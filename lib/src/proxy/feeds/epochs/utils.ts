// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for epoch feed finders
 */

import { Binary } from "cafe-utility"
import {
  Identifier,
  type BeeRequestOptions,
  type EthAddress,
  type Topic,
} from "@ethersphere/bee-js"
import {
  downloadEncryptedSOC,
  downloadSOC,
  type ChunkDownloader,
} from "../../download-data"
import { EpochIndex } from "./epoch"

const MAX_LEAF_BACKSCAN = 128n
const EPOCH_LOOKUP_TIMEOUT_MS = 2000
const SPAN_SIZE = 8
const TIMESTAMP_SIZE = 8
const PLAIN_REF_SIZE = 32
const ENCRYPTED_REF_SIZE = 64

/**
 * Payload lengths an epoch entry may have: `timestamp ‖ reference`, as written
 * through `/soc`, or the same with an 8-byte span in front, as the v1 `/chunks`
 * format writes it. The reference is 32 bytes, or 64 when encrypted.
 */
const PLAIN_PAYLOAD_SIZE = TIMESTAMP_SIZE + PLAIN_REF_SIZE
const ENCRYPTED_PAYLOAD_SIZE = TIMESTAMP_SIZE + ENCRYPTED_REF_SIZE
const BARE_PAYLOAD_SIZES = [PLAIN_PAYLOAD_SIZE, ENCRYPTED_PAYLOAD_SIZE]
const SPAN_PREFIXED_PAYLOAD_SIZES = BARE_PAYLOAD_SIZES.map(
  (size) => SPAN_SIZE + size,
)

/** One epoch-feed entry: the reference it points at and when it was written. */
export interface EpochEntry {
  reference: Uint8Array
  timestamp: bigint
}

/**
 * Build the SOC identifier for one epoch of a topic's epoch feed:
 * `keccak256(topic ‖ epoch.marshalBinary())`. Exported so readers can
 * reconstruct the SOC address of a feed entry they found (e.g. the
 * partition-state reader compensates for the slot the entry's own SOC
 * consumed).
 */
export async function makeEpochIdentifier(
  topic: Topic,
  epoch: EpochIndex,
): Promise<Identifier> {
  const epochHash = await epoch.marshalBinary()
  return new Identifier(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), epochHash)),
  )
}

/**
 * Fetch the entry at `epoch` and return it if it was written at or before
 * `at`. Returns undefined for a later entry or a payload of no known layout.
 *
 * @throws when the chunk is missing, or is not a SOC signed by `owner`
 */
export async function fetchEpochEntry(
  bee: ChunkDownloader,
  topic: Topic,
  owner: EthAddress,
  epoch: EpochIndex,
  at: bigint,
  encryptionKey?: Uint8Array,
): Promise<EpochEntry | undefined> {
  const identifier = await makeEpochIdentifier(topic, epoch)
  const requestOptions: BeeRequestOptions = {
    timeout: EPOCH_LOOKUP_TIMEOUT_MS,
  }
  const soc = encryptionKey
    ? await downloadEncryptedSOC(
        bee,
        owner,
        identifier,
        encryptionKey,
        requestOptions,
      )
    : await downloadSOC(bee, owner, identifier, requestOptions)

  const entry = parseEpochPayload(soc.payload)
  if (!entry || entry.timestamp > at) {
    return undefined
  }
  return entry
}

function parseEpochPayload(payload: Uint8Array): EpochEntry | undefined {
  const spanPrefixed = SPAN_PREFIXED_PAYLOAD_SIZES.includes(payload.length)
  if (!spanPrefixed && !BARE_PAYLOAD_SIZES.includes(payload.length)) {
    console.warn(
      `Unexpected feed payload length: ${payload.length}. Expected one of ${[...BARE_PAYLOAD_SIZES, ...SPAN_PREFIXED_PAYLOAD_SIZES].join(", ")} bytes.`,
    )
    return undefined
  }

  const timestampOffset = spanPrefixed ? SPAN_SIZE : 0
  const timestamp = new DataView(
    payload.buffer,
    payload.byteOffset + timestampOffset,
    TIMESTAMP_SIZE,
  ).getBigUint64(0, false)
  return {
    reference: payload.slice(timestampOffset + TIMESTAMP_SIZE),
    timestamp,
  }
}

/**
 * Type for the chunk fetcher callback used by findPreviousLeaf.
 * This allows both sync and async finders to share the same logic.
 */
export type EpochChunkFetcher = (
  at: bigint,
  epoch: EpochIndex,
) => Promise<Uint8Array | undefined>

/**
 * Find a previous leaf chunk by scanning backwards from the target timestamp.
 *
 * This is a recovery fallback for poisoned-ancestor histories where the tree
 * traversal fails but valid leaf nodes exist.
 *
 * @param at - Target unix timestamp (seconds)
 * @param after - Hint of latest known update timestamp (0 if unknown)
 * @param getEpochChunk - Callback function to fetch epoch chunks
 * @returns 32-byte Swarm reference, or undefined if no update found
 */
export async function findPreviousLeaf(
  at: bigint,
  after: bigint,
  getEpochChunk: EpochChunkFetcher,
): Promise<Uint8Array | undefined> {
  if (at === 0n) {
    return undefined
  }

  const minAt = after > 0n ? after : 0n
  const lowerBound =
    at > MAX_LEAF_BACKSCAN && at - MAX_LEAF_BACKSCAN > minAt
      ? at - MAX_LEAF_BACKSCAN
      : minAt

  let probe = at - 1n
  while (probe >= lowerBound) {
    try {
      const leaf = await getEpochChunk(at, new EpochIndex(probe, 0))
      if (leaf) {
        return leaf
      }
    } catch {
      // Missing leaf at probe timestamp.
    }

    if (probe === 0n) {
      break
    }
    probe--
  }

  return undefined
}
