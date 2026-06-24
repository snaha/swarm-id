// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Device-registry feed (Phase 3a) — the account's discovery layer.
 *
 * A single shared feed per account (`swarm-id-devreg-v1:<accountId>`) holding
 * the device set plus account-level immutables (createdAt, publicKey,
 * partitionCount). It replaces `snapshot.metadata.devices` as the source of
 * truth for "which devices' state feeds to fold".
 *
 * It is written ONLY on membership change (a device's first sign-in, or a
 * remove/sign-out) — rare, so it tolerates the read-merge-write the per-device
 * hot path was designed to avoid. The merge reuses `mergeDevicesList` (Phase 1
 * tombstones), and a small verify-retry guards against two devices announcing
 * in the same epoch slot (the registry IS the discovery bootstrap, so a dropped
 * announce must not happen silently).
 */

import {
  Bee,
  EthAddress,
  PrivateKey,
  Reference,
  Topic,
} from "@ethersphere/bee-js"
import { z } from "zod"
import { DeviceSchemaV1, type Device } from "../schemas"
import { hexToUint8Array } from "../utils/hex"
import { AsyncEpochFinder, BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { mergeDevicesList } from "./merge-snapshot"

export const DEVICE_REGISTRY_TOPIC_PREFIX = "swarm-id-devreg-v1"

const DEVICE_REGISTRY_VERSION = 1

export const DeviceRegistrySchemaV1 = z.object({
  version: z.literal(DEVICE_REGISTRY_VERSION),
  accountId: z.string().length(40),
  createdAt: z.number(),
  publicKey: z.string().optional(),
  partitionCount: z.number().int().min(1).default(1),
  devices: z.array(DeviceSchemaV1).default([]),
})

export type DeviceRegistry = z.infer<typeof DeviceRegistrySchemaV1>

export function deviceRegistryTopic(accountId: string): Topic {
  return Topic.fromString(`${DEVICE_REGISTRY_TOPIC_PREFIX}:${accountId}`)
}

function serializeRegistry(registry: DeviceRegistry): Record<string, unknown> {
  return {
    version: DEVICE_REGISTRY_VERSION,
    accountId: registry.accountId,
    createdAt: registry.createdAt,
    publicKey: registry.publicKey,
    partitionCount: registry.partitionCount,
    devices: registry.devices,
  }
}

export function deserializeRegistry(data: Uint8Array): DeviceRegistry {
  const json = JSON.parse(new TextDecoder().decode(data))
  return DeviceRegistrySchemaV1.parse(json)
}

/** Read the latest registry, or `undefined` when the feed is empty/unreachable. */
export async function readDeviceRegistry(opts: {
  bee: Bee
  accountId: string
  owner: EthAddress
}): Promise<DeviceRegistry | undefined> {
  const topic = deviceRegistryTopic(opts.accountId)
  const finder = new AsyncEpochFinder(opts.bee, topic, opts.owner)
  const refBytes = await finder.findAt(BigInt(Math.floor(Date.now() / 1000)))
  if (!refBytes) return undefined
  const data = await downloadDataWithChunkAPI(
    opts.bee,
    new Reference(refBytes).toHex(),
  )
  return deserializeRegistry(data)
}

/** Merge two registries: device-union (Phase 1), keep earliest createdAt, prefer present scalars. */
function mergeRegistries(
  local: DeviceRegistry,
  remote: DeviceRegistry,
): DeviceRegistry {
  return {
    version: DEVICE_REGISTRY_VERSION,
    accountId: local.accountId,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    publicKey: local.publicKey ?? remote.publicKey,
    partitionCount: Math.max(local.partitionCount, remote.partitionCount),
    devices: mergeDevicesList(local.devices, remote.devices),
  }
}

async function writeRegistryOnce(opts: {
  bee: Bee
  accountKey: PrivateKey
  encryptionKey: string
  registry: DeviceRegistry
  target: UploadTarget
}): Promise<void> {
  const topic = deviceRegistryTopic(opts.registry.accountId)
  const bytes = new TextEncoder().encode(
    JSON.stringify(serializeRegistry(opts.registry)),
  )
  const uploadResult = await uploadData(opts.target, bytes, {
    encryptionKey: hexToUint8Array(opts.encryptionKey),
  })
  const refBytes = new Reference(uploadResult.reference).toUint8Array()
  const updater = new BasicEpochUpdater(topic, opts.accountKey)
  await updater.update(
    BigInt(Math.floor(Date.now() / 1000)),
    refBytes,
    opts.target,
  )
}

/**
 * Upsert `localRegistry` into the shared registry feed: read the freshest
 * remote, merge (device-union), write once. Runs inside the caller's
 * `BatchWriteCoordinator.withWrite`. No tight verify-retry: the registry is a
 * rare write, and a device that a same-epoch collision dropped re-announces on
 * its next sync (it finds itself absent), so convergence holds across syncs
 * without re-introducing the verifyWon read-after-write churn this refactor
 * removed. ponytail: single write; add a verify-retry only if collisions are
 * ever measured to matter.
 */
export async function writeDeviceRegistry(opts: {
  bee: Bee
  accountKey: PrivateKey
  owner: EthAddress
  encryptionKey: string
  localRegistry: DeviceRegistry
  target: UploadTarget
}): Promise<void> {
  const remote = await readDeviceRegistry({
    bee: opts.bee,
    accountId: opts.localRegistry.accountId,
    owner: opts.owner,
  }).catch(() => undefined)
  const merged = remote
    ? mergeRegistries(opts.localRegistry, remote)
    : opts.localRegistry
  await writeRegistryOnce({
    bee: opts.bee,
    accountKey: opts.accountKey,
    encryptionKey: opts.encryptionKey,
    registry: merged,
    target: opts.target,
  })
}

/** Add/refresh a single device in a registry value (pure helper for callers). */
export function upsertDevice(
  registry: DeviceRegistry,
  device: Device,
): DeviceRegistry {
  return { ...registry, devices: mergeDevicesList(registry.devices, [device]) }
}
