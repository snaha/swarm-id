// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared test fixtures for backup-encryption, account-state-snapshot, and sync tests.
 */
import { EthAddress, BatchId, PrivateKey } from "@ethersphere/bee-js"
import type {
  SyncedAccount,
  SignedInAccount,
  SignedOutAccount,
  Device,
  ConnectedApp,
  PostageStamp,
} from "./schemas"

export const TEST_ETH_ADDRESS_HEX = "a".repeat(40)
export const TEST_ETH_ADDRESS_2_HEX = "b".repeat(40)
export const TEST_IDENTITY_ADDRESS_HEX = "1".repeat(40)
export const TEST_IDENTITY_ADDRESS_2_HEX = "2".repeat(40)
export const TEST_BATCH_ID_HEX = "c".repeat(64)
export const TEST_BATCH_ID_2_HEX = "e".repeat(64)
export const TEST_PRIVATE_KEY_HEX = "d".repeat(64)
export const TEST_DERIVATION_KEY_HEX = "f".repeat(64)
// Compressed secp256k1 public key: 0x02/0x03 prefix byte + 32 bytes = 66 bare hex chars.
export const TEST_PUBLIC_KEY_HEX = "02" + "ab".repeat(32)
export const DIFFERENT_DERIVATION_KEY_HEX = "1".repeat(64)
export const TEST_DEVICE_ID = "550e8400-e29b-41d4-a716-446655440000"

export function createDevice(overrides?: Partial<Device>): Device {
  return {
    deviceId: TEST_DEVICE_ID,
    createdAt: 1700000000000,
    lastSignedInAt: 1700000000000,
    ...overrides,
  }
}

/** The synced (portable) fields both account fixtures share. */
function createSyncedAccount(): SyncedAccount {
  return {
    id: new EthAddress(TEST_ETH_ADDRESS_HEX),
    name: "Test Account",
    createdAt: 1700000000000,
    publicKey: TEST_PUBLIC_KEY_HEX,
    derivationKey: TEST_DERIVATION_KEY_HEX,
    devices: [],
    connectedApps: [],
    postageStamps: [],
  }
}

/**
 * The signed-in account fixture. Every account is a BIP-39 seed account with an
 * `access` + `encryptedSeed` vault (defaulted here to a password vault);
 * override them to model a different access method. For the signed-out variant
 * (vault wiped) use `createSignedOutAccount`.
 */
export function createAccount(
  overrides?: Partial<SignedInAccount>,
): SignedInAccount {
  return {
    ...createSyncedAccount(),
    access: { type: "password", kdfSalt: "00", kdfIterations: 100000 },
    encryptedSeed: "aabbccdd",
    ...overrides,
  }
}

/** Signed-out counterpart of `createAccount`: no vault, `signedOutAt` set. */
export function createSignedOutAccount(
  overrides?: Partial<SignedOutAccount>,
): SignedOutAccount {
  return {
    ...createSyncedAccount(),
    signedOutAt: 1700000000001,
    ...overrides,
  }
}

export function createConnectedApp(
  overrides?: Partial<ConnectedApp>,
): ConnectedApp {
  return {
    appUrl: "https://app.example.com",
    appName: "Test App",
    lastConnectedAt: 1700000000000,
    appSecret: "secret-should-be-stripped",
    ...overrides,
  }
}

export function createPostageStamp(
  overrides?: Partial<PostageStamp>,
): PostageStamp {
  return {
    batchID: new BatchId(TEST_BATCH_ID_HEX),
    signerKey: new PrivateKey(TEST_PRIVATE_KEY_HEX),
    utilization: 0,
    usable: true,
    depth: 20,
    amount: 100000000n,
    bucketDepth: 16,
    blockNumber: 12345678,
    immutableFlag: false,
    exists: true,
    createdAt: 1700000000000,
    ...overrides,
  }
}
