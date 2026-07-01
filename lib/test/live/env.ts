// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared setup for the live test suite.
 *
 * These tests drive one or more simulated devices of a throwaway account through
 * the REAL library publish → fold → restore path against a live remote Bee
 * backend (default = the public gateway), stamping uploads with a real postage
 * batch. They are opt-in (see README):
 * every config value comes from a gitignored `.env` (loaded by `setup.ts`), and
 * each suite `describe.skipIf(!liveEnv.configured)`s itself when no
 * `BATCH_ID`/`SIGNER_KEY` is present — so a bare `pnpm test:live` skips
 * cleanly and CI (which never invokes it) is unaffected.
 *
 * Mirrors `test/integration/cluster.ts`, but the backend + stamp come from env
 * (a funded on-chain batch + its signer key) instead of a local dev cluster.
 */

import { randomBytes } from "node:crypto"
import { Bee, BatchId, PrivateKey, Stamper } from "@ethersphere/bee-js"
import type { UploadTarget } from "../../src/proxy/upload"
import {
  deriveAccountDerivationKey,
  deriveSwarmEncryptionKey,
  deriveSecret,
  backupKeyToPrivateKey,
} from "../../src/utils/key-derivation"
import { foldAccountFromSwarm } from "../../src/sync/fold-account-from-swarm"
import type { DeviceStateView } from "../../src/sync/device-state"
import type { ConnectedApp, Device, PostageStamp } from "../../src/schemas"

const DEFAULT_BEE_URL = "https://api.gateway.ethswarm.org/"
const KEY_BYTES = 32

/**
 * Stand-in account public key for the now-REQUIRED `DeviceStateView`/
 * `DeviceStateSnapshotSchemaV1.accountPublicKey` field (#377/#381 made it
 * mandatory). The read schema only requires a string, and the fold just needs it
 * present + consistent across an account's device feeds — these throwaway test
 * accounts never validate its curve identity — so one shared compressed-pubkey-
 * shaped constant suffices. Without it, every published snapshot fails read
 * validation → `readLatestDeviceState` returns undefined → the fold sees no views
 * and returns undefined (the `views.length === 0` guard).
 */
export const TEST_ACCOUNT_PUBLIC_KEY = `02${"11".repeat(KEY_BYTES)}`

const str = (name: string): string | undefined => {
  const v = process.env[name]
  return v && v.length > 0 ? v : undefined
}
const num = (name: string, fallback: number): number =>
  Number(str(name) ?? fallback)

/** Parsed env + the timing knobs the scenarios honour. Gateway-sized defaults. */
export const liveEnv = {
  beeUrl: str("BEE_URL") ?? DEFAULT_BEE_URL,
  batchIdHex: str("BATCH_ID"),
  signerKeyHex: str("SIGNER_KEY"),
  depth: num("DEPTH", 21),
  amount: str("AMOUNT") ?? "0",
  // The append-only roster / device feeds are negative-cached ~50s on the
  // gateway; space simultaneous announces beyond that so a peer's write is
  // readable before the next device folds.
  propDelayMs: num("PROP_DELAY_MS", 70_000),
  restorePollTries: num("RESTORE_POLL_TRIES", 24),
  restorePollDelayMs: num("RESTORE_POLL_DELAY_MS", 8_000),
  // Partition-contention knobs (kept tight so acquires finish within the 30s TTL).
  idleMs: num("IDLE_MS", 38_000),
  keepAliveEveryMs: num("KEEPALIVE_EVERY_MS", 10_000),
  acquireGapMs: num("ACQUIRE_GAP_MS", 2_000),
  intentWindowMs: num("INTENT_WINDOW_MS", 2_000),
  guardMs: num("GUARD_MS", 1_000),
  /** True only when a batch + signer key are configured (else the suites skip). */
  get configured(): boolean {
    return Boolean(this.batchIdHex && this.signerKeyHex)
  },
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface LiveContext {
  bee: Bee
  batchID: BatchId
  signerKey: PrivateKey
  depth: number
  target: UploadTarget
}

/** Bee client + stamper-mode upload target for the configured batch. */
export function createContext(): LiveContext {
  const bee = new Bee(liveEnv.beeUrl)
  const batchID = new BatchId(liveEnv.batchIdHex!)
  const signerKey = new PrivateKey(liveEnv.signerKeyHex!)
  const target: UploadTarget = {
    mode: "stamper",
    bee,
    stamper: Stamper.fromBlank(signerKey, batchID, liveEnv.depth),
  }
  return { bee, batchID, signerKey, depth: liveEnv.depth, target }
}

/**
 * Derive one throwaway account's keys (reader == writer): account id + the
 * backup feed owner/key + the swarm encryption key, exactly as
 * `restoreAccountFromSwarm` does.
 */
export async function deriveAgentKeys() {
  const masterKeyHex = hex(randomBytes(KEY_BYTES))
  const accountAddress = new PrivateKey(hex(randomBytes(KEY_BYTES)))
    .publicKey()
    .address()
  const derivationKey = await deriveAccountDerivationKey(masterKeyHex)
  const swarmEncryptionKey = await deriveSwarmEncryptionKey(derivationKey)
  const accountKey = backupKeyToPrivateKey(
    await deriveSecret(swarmEncryptionKey, "backup-key"),
  )
  return {
    accountId: accountAddress.toHex(),
    derivationKey,
    accountKey,
    owner: accountKey.publicKey().address(),
    encryptionKey: swarmEncryptionKey,
  }
}

/** A unique device id (`<prefix>-<rand>`). */
export function deviceId(prefix: string): string {
  return `${prefix}-${hex(randomBytes(4))}`
}

export function makeDevice(id: string, name: string): Device {
  const now = Date.now()
  return { deviceId: id, name, createdAt: now, lastSignedInAt: now }
}

export function makeStamp(
  batchID: BatchId,
  signerKey: PrivateKey,
  depth: number,
  deletedAt?: number,
): PostageStamp {
  return {
    batchID,
    signerKey,
    utilization: 0,
    usable: true,
    depth,
    amount: BigInt(liveEnv.amount),
    bucketDepth: 16,
    blockNumber: 0,
    immutableFlag: false,
    exists: true,
    createdAt: 1_000,
    ...(deletedAt ? { deletedAt } : {}),
  }
}

export function makeView(over: Partial<DeviceStateView> = {}): DeviceStateView {
  return {
    connectedApps: [],
    postageStamps: [],
    accountName: { value: "live-test", at: 1 },
    defaultPostageStampBatchID: { value: undefined, at: 1 },
    settings: { value: undefined, at: 1 },
    accountPublicKey: TEST_ACCOUNT_PUBLIC_KEY,
    accountCreatedAt: 1_000,
    partitionCount: 2,
    ...over,
  }
}

export function makeApp(url: string): ConnectedApp {
  const now = Date.now()
  return { appUrl: url, appName: url, lastConnectedAt: now, updatedAt: now }
}

/** The shape `foldAccountFromSwarm` returns for `.account`. */
export type FoldedAccount = NonNullable<
  Awaited<ReturnType<typeof foldAccountFromSwarm>>
>["account"]

/**
 * Poll `foldAccountFromSwarm` until `predicate` holds (read-after-write lag on
 * the gateway) or the poll budget runs out; returns the converged account or
 * `undefined`.
 */
export async function foldUntil(
  bee: Bee,
  derivationKey: string,
  accountId: string,
  predicate: (a: FoldedAccount) => boolean,
  what: string,
): Promise<FoldedAccount | undefined> {
  const t0 = Date.now()
  for (let i = 0; i < liveEnv.restorePollTries; i++) {
    const folded = await foldAccountFromSwarm({
      bee,
      derivationKey,
      accountId,
    }).catch(() => undefined)
    if (folded && predicate(folded.account)) {
      console.log(
        `  converged on "${what}" after ${i + 1} poll(s), ${Date.now() - t0}ms`,
      )
      return folded.account
    }
    await delay(liveEnv.restorePollDelayMs)
  }
  console.log(`  ⚠️  fold never converged on: ${what} (${Date.now() - t0}ms)`)
  return undefined
}
