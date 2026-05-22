// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-device claim feed for multi-device postage-batch sharing.
 *
 * The atomicity trick: a *shared* lease SOC would race; instead each
 * device owns its own claim feed and only it ever writes there. The set
 * of current claims = union of every known device's latest entry.
 *
 * Topic = keccak256("swarm-id-device-claim-v1" ‖ accountId ‖ deviceId)
 * Owner = backup signer
 *
 * Payloads are small (`PartitionClaim`), encrypted with the account's
 * `swarmEncryptionKey` so the per-device partition assignment isn't
 * trivially observable to anyone scanning the feed.
 */

import {
  Bee,
  EthAddress,
  PrivateKey,
  Reference,
  Topic,
  type Stamper,
} from "@ethersphere/bee-js"
import { Binary } from "cafe-utility"
import { AsyncEpochFinder } from "../proxy/feeds/epochs/async-finder"
import { BasicEpochUpdater } from "../proxy/feeds/epochs/updater"
import type {
  EpochUpdateHints,
  EpochUpdateResult,
} from "../proxy/feeds/epochs/types"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { PartitionClaimSchemaV1, type PartitionClaim } from "../schemas"

/** Domain-separation tag for device-claim-feed topics. */
const DEVICE_CLAIM_TOPIC_DOMAIN = "swarm-id-device-claim-v1"

/** Partition value signalling "no claim" (i.e. an explicit release). */
export const NO_CLAIM_PARTITION = -1

/**
 * Build the per-device claim-feed topic.
 *
 * `accountId` is the account's Ethereum address (40-char hex, no `0x`)
 * and `deviceId` is the device's localStorage UUID.
 */
export function makeDeviceClaimTopic(
  accountId: string,
  deviceId: string,
): Topic {
  const hash = Binary.keccak256(
    new TextEncoder().encode(
      `${DEVICE_CLAIM_TOPIC_DOMAIN}:${accountId}:${deviceId}`,
    ),
  )
  return new Topic(hash)
}

/**
 * Read a device's latest claim. Returns `undefined` if the device has
 * never written to its claim feed.
 */
export async function readDeviceClaim(opts: {
  bee: Bee
  owner: EthAddress
  accountId: string
  deviceId: string
}): Promise<PartitionClaim | undefined> {
  const { bee, owner, accountId, deviceId } = opts
  const topic = makeDeviceClaimTopic(accountId, deviceId)
  const finder = new AsyncEpochFinder(bee, topic, owner)
  const now = BigInt(Math.floor(Date.now() / 1000))

  const refBytes = await finder.findAt(now)
  if (!refBytes) return undefined

  const reference = new Reference(refBytes)
  const payloadBytes = await downloadDataWithChunkAPI(bee, reference.toHex())
  return PartitionClaimSchemaV1.parse(
    JSON.parse(new TextDecoder().decode(payloadBytes)),
  )
}

/**
 * Write a new claim entry to this device's claim feed.
 *
 * Returns the epoch hints; callers (e.g. the lease's refresh path)
 * should pass them back on subsequent writes so the bee-js epoch tree
 * doesn't get traversed from the root every time.
 */
export async function writeDeviceClaim(opts: {
  bee: Bee
  stamper: Stamper
  accountId: string
  deviceId: string
  claim: PartitionClaim
  swarmEncryptionKey: Uint8Array
  backupSigner: PrivateKey
  hints?: EpochUpdateHints
}): Promise<EpochUpdateResult> {
  const {
    bee,
    stamper,
    accountId,
    deviceId,
    claim,
    swarmEncryptionKey,
    backupSigner,
    hints,
  } = opts

  const payloadJson = new TextEncoder().encode(JSON.stringify(claim))

  // 1. Upload the encrypted claim payload via the existing stamper.
  const target: UploadTarget = { mode: "stamper", bee, stamper }
  const uploadResult = await uploadData(target, payloadJson, {
    encryptionKey: swarmEncryptionKey,
  })

  // 2. Point this device's claim feed at the new reference.
  const topic = makeDeviceClaimTopic(accountId, deviceId)
  const updater = new BasicEpochUpdater(topic, backupSigner)
  const refBytes = new Reference(uploadResult.reference).toUint8Array()
  const feedTimestamp = BigInt(Math.floor(Date.now() / 1000))
  return updater.update(feedTimestamp, refBytes, target, undefined, hints)
}
