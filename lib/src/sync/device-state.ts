// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-device account-state feed (Phase 3a).
 *
 * Each device publishes its own **full current account view** to its OWN feed
 * (`swarm-id-devstate-v1:<accountId>:<deviceId>`). Because a device writes only
 * its own feed there is no shared SOC address and no cross-device write
 * contention — the `publishAccountState` merge-read-rewrite + `verifyWon` dance
 * is gone. Convergence happens at READ time: `foldAccount` merges every device's
 * latest view with the Phase 1 merge primitives.
 *
 * Device membership (the `deviceId` set) lives in the append-only device roster
 * (`device-roster.ts`), not here; account-level immutables (publicKey, createdAt,
 * partitionCount) ride this robust per-device feed so the fold reconstructs them
 * without a shared doc. Scalar account fields carry per-field LWW clocks so a
 * concurrent change to a different scalar on another device is not dropped (§9.3).
 */

import {
  Bee,
  BatchId,
  EthAddress,
  PrivateKey,
  Reference,
  Topic,
} from "@ethersphere/bee-js"
import { z } from "zod"
import {
  ConnectedAppSchemaV1,
  PostageStampSchemaV1,
  type ConnectedApp,
  type Device,
  type PostageStamp,
} from "../schemas"
import {
  serializeConnectedApp,
  serializePostageStamp,
} from "../utils/storage-managers"
import { hexToUint8Array } from "../utils/hex"
import { AsyncEpochFinder, BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadData, type UploadTarget } from "../proxy/upload"
import { downloadDataWithChunkAPI } from "../proxy/download-data"
import { mergeConnectedApps, mergePostageStamps } from "./merge-snapshot"
import { ensureInRoster } from "./device-roster"
import type { SyncResult } from "./types"

export const DEVICE_STATE_TOPIC_PREFIX = "swarm-id-devstate-v1"

const DEVICE_STATE_VERSION = 1

/** Account settings carried in a device view (mirrors `account.settings`). */
const SettingsSchema = z.object({ appSessionDuration: z.number().optional() })
export type AccountSettings = z.infer<typeof SettingsSchema>

const ClockedSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, at: z.number() })

/**
 * One device's view of the account. `connectedApps`/`postageStamps` carry their
 * Phase 1 LWW/tombstone clocks; scalars carry their own per-field `at`.
 */
export const DeviceStateSnapshotSchemaV1 = z.object({
  version: z.literal(DEVICE_STATE_VERSION),
  accountId: z.string().length(40),
  deviceId: z.string(),
  timestamp: z.number(),
  connectedApps: z.array(ConnectedAppSchemaV1),
  postageStamps: z.array(PostageStampSchemaV1),
  accountName: ClockedSchema(z.string()),
  defaultPostageStampBatchID: ClockedSchema(z.string().length(64).optional()),
  settings: ClockedSchema(SettingsSchema.optional()),
  // Account-level immutables — carried on the robust per-device feed (not the
  // roster), so the fold reconstructs them without a shared doc. Identical
  // across devices.
  accountPublicKey: z.string().optional(),
  accountCreatedAt: z.number(),
  partitionCount: z.number().int().min(1).default(1),
})

export type DeviceStateSnapshot = z.infer<typeof DeviceStateSnapshotSchemaV1>

/** The per-device view a device contributes (mutable collections/scalars + account immutables). */
export interface DeviceStateView {
  connectedApps: ConnectedApp[]
  postageStamps: PostageStamp[]
  accountName: { value: string; at: number }
  defaultPostageStampBatchID: { value: string | undefined; at: number }
  settings: { value: AccountSettings | undefined; at: number }
  accountPublicKey?: string
  accountCreatedAt: number
  partitionCount: number
}

/** Folded account state — the shape `applyRefreshed` / the proxy consume. */
export interface FoldedAccount {
  devices: Device[]
  connectedApps: ConnectedApp[]
  postageStamps: PostageStamp[]
  accountName: string
  defaultPostageStampBatchID: BatchId | undefined
  settings: AccountSettings | undefined
  // Per-field LWW clock of each scalar's winning value, so refresh/restore can
  // apply it by LWW against the local clock.
  accountNameAt: number
  defaultStampAt: number
  settingsAt: number
  createdAt: number
  publicKey?: string
  partitionCount: number
}

export function deviceStateTopic(accountId: string, deviceId: string): Topic {
  return Topic.fromString(
    `${DEVICE_STATE_TOPIC_PREFIX}:${accountId}:${deviceId}`,
  )
}

export function serializeDeviceState(
  accountId: string,
  deviceId: string,
  view: DeviceStateView,
): Record<string, unknown> {
  return {
    version: DEVICE_STATE_VERSION,
    accountId,
    deviceId,
    timestamp: Date.now(),
    connectedApps: view.connectedApps.map(serializeConnectedApp),
    postageStamps: view.postageStamps.map(serializePostageStamp),
    accountName: view.accountName,
    defaultPostageStampBatchID: view.defaultPostageStampBatchID,
    settings: view.settings,
    accountPublicKey: view.accountPublicKey,
    accountCreatedAt: view.accountCreatedAt,
    partitionCount: view.partitionCount,
  }
}

export function deserializeDeviceState(data: Uint8Array): DeviceStateSnapshot {
  const json = JSON.parse(new TextDecoder().decode(data))
  return DeviceStateSnapshotSchemaV1.parse(json)
}

/**
 * Write this device's view to its own feed. No merge / no verifyWon — the feed
 * is owned exclusively by this device. Runs inside the caller's
 * `BatchWriteCoordinator.withWrite` (partition lease + Web Lock already held),
 * which supplies `target`.
 */
export async function writeDeviceState(opts: {
  accountId: string
  deviceId: string
  accountKey: PrivateKey
  encryptionKey: string
  view: DeviceStateView
  target: UploadTarget
}): Promise<{ reference: string; chunkAddresses: Uint8Array[] }> {
  const topic = deviceStateTopic(opts.accountId, opts.deviceId)
  const json = serializeDeviceState(opts.accountId, opts.deviceId, opts.view)
  const bytes = new TextEncoder().encode(JSON.stringify(json))
  const uploadResult = await uploadData(opts.target, bytes, {
    encryptionKey: hexToUint8Array(opts.encryptionKey),
  })
  const chunkAddresses = uploadResult.chunkAddresses ?? []
  const refBytes = new Reference(uploadResult.reference).toUint8Array()
  const updater = new BasicEpochUpdater(topic, opts.accountKey)
  const updateResult = await updater.update(
    BigInt(Math.floor(Date.now() / 1000)),
    refBytes,
    opts.target,
  )
  chunkAddresses.push(updateResult.socAddress)
  return { reference: uploadResult.reference, chunkAddresses }
}

/**
 * Write this device's view AND ensure it's in the append-only device roster. The
 * single write entry point for both `sync-account` (UI-triggered) and the proxy
 * (publish-on-acquire). `ensureInRoster` appends only when this device is absent
 * or its removed-state changed — keeping the roster a rare, clobber-free write.
 */
export async function publishDeviceState(opts: {
  bee: Bee
  accountId: string
  device: Device
  accountKey: PrivateKey
  owner: EthAddress
  encryptionKey: string
  view: DeviceStateView
  target: UploadTarget
  /** Per-chunk utilisation hook (mirrors the old publish path). */
  onChunksUploaded?: (chunkAddresses: Uint8Array[]) => Promise<void>
}): Promise<SyncResult> {
  const written = await writeDeviceState({
    accountId: opts.accountId,
    deviceId: opts.device.deviceId,
    accountKey: opts.accountKey,
    encryptionKey: opts.encryptionKey,
    view: opts.view,
    target: opts.target,
  })

  if (opts.onChunksUploaded && written.chunkAddresses.length > 0) {
    // Don't fail the write if utilisation tracking throws.
    await opts.onChunksUploaded(written.chunkAddresses).catch((err) => {
      console.error("[publishDeviceState] utilisation hook failed:", err)
    })
  }

  await ensureInRoster({
    bee: opts.bee,
    accountKey: opts.accountKey,
    owner: opts.owner,
    encryptionKey: opts.encryptionKey,
    accountId: opts.accountId,
    device: opts.device,
    target: opts.target,
  })

  return {
    status: "success",
    reference: written.reference,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    chunkAddresses: written.chunkAddresses,
  }
}

/**
 * Read a device's latest view, or `undefined` when its feed is empty/unreachable.
 */
export async function readLatestDeviceState(opts: {
  bee: Bee
  accountId: string
  deviceId: string
  owner: EthAddress
}): Promise<DeviceStateSnapshot | undefined> {
  const topic = deviceStateTopic(opts.accountId, opts.deviceId)
  const finder = new AsyncEpochFinder(opts.bee, topic, opts.owner)
  const refBytes = await finder.findAt(BigInt(Math.floor(Date.now() / 1000)))
  if (!refBytes) return undefined
  const data = await downloadDataWithChunkAPI(
    opts.bee,
    new Reference(refBytes).toHex(),
  )
  return deserializeDeviceState(data)
}

function pickLatest<T extends { at: number }>(a: T, b: T): T {
  // Ties favour the later-processed entry (b), matching the merge primitives'
  // "remote then local" ordering; timestamps differ in practice.
  return b.at >= a.at ? b : a
}

/**
 * Merge every device's latest view into one account state, reusing the Phase 1
 * primitives for the collections and per-field LWW for the scalars. The device
 * set (`rosterDevices`) comes from the append-only roster (discovery); account
 * immutables come from any device view (identical across devices).
 *
 * Equivalent by construction to today's `mergeSnapshotWithRemote` over the same
 * data (see the differential test) — convergence and deletion semantics are
 * unchanged from Phase 1.
 */
export function foldAccount(
  views: DeviceStateSnapshot[],
  rosterDevices: Device[],
): FoldedAccount {
  let connectedApps: ConnectedApp[] = []
  let postageStamps: PostageStamp[] = []
  let accountName = { value: "", at: 0 }
  let defaultBatch: { value?: string; at: number } = { at: 0 }
  let settings: { value?: AccountSettings; at: number } = { at: 0 }

  for (const v of views) {
    connectedApps = mergeConnectedApps(connectedApps, v.connectedApps)
    postageStamps = mergePostageStamps(postageStamps, v.postageStamps)
    accountName = pickLatest(accountName, v.accountName)
    defaultBatch = pickLatest(defaultBatch, v.defaultPostageStampBatchID)
    settings = pickLatest(settings, v.settings)
  }

  // Account immutables from any view; fall back to the roster (min createdAt) so
  // a fold with reachable roster but no readable device feed still has them.
  const meta = views[0]
  const createdAt =
    meta?.accountCreatedAt ??
    rosterDevices.reduce(
      (min, d) => Math.min(min, d.createdAt),
      Number.MAX_SAFE_INTEGER,
    )

  return {
    devices: rosterDevices,
    connectedApps,
    postageStamps,
    accountName: accountName.value,
    defaultPostageStampBatchID: defaultBatch.value
      ? new BatchId(defaultBatch.value)
      : undefined,
    settings: settings.value,
    accountNameAt: accountName.at,
    defaultStampAt: defaultBatch.at,
    settingsAt: settings.at,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    publicKey: meta?.accountPublicKey,
    partitionCount: meta?.partitionCount ?? 1,
  }
}
