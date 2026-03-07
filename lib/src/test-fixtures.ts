/**
 * Shared test fixtures for backup-encryption, account-state-snapshot, and sync tests.
 */
import { EthAddress, BatchId, PrivateKey, Bytes } from "@ethersphere/bee-js"
import type {
  PasskeyAccount,
  EthereumAccount,
  AgentAccount,
  Identity,
  ConnectedApp,
  PostageStamp,
} from "./schemas"

export const TEST_ETH_ADDRESS_HEX = "a".repeat(40)
export const TEST_ETH_ADDRESS_2_HEX = "b".repeat(40)
export const TEST_BATCH_ID_HEX = "c".repeat(64)
export const TEST_BATCH_ID_2_HEX = "e".repeat(64)
export const TEST_PRIVATE_KEY_HEX = "d".repeat(64)
export const TEST_ENCRYPTION_KEY_HEX = "f".repeat(64)
export const DIFFERENT_ENCRYPTION_KEY_HEX = "1".repeat(64)

export function createPasskeyAccount(
  overrides?: Partial<PasskeyAccount>,
): PasskeyAccount {
  return {
    id: new EthAddress(TEST_ETH_ADDRESS_HEX),
    name: "Test Passkey Account",
    createdAt: 1700000000000,
    type: "passkey" as const,
    credentialId: "credential-abc-123",
    swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
    ...overrides,
  }
}

export function createEthereumAccount(
  overrides?: Partial<EthereumAccount>,
): EthereumAccount {
  return {
    id: new EthAddress(TEST_ETH_ADDRESS_HEX),
    name: "Test Ethereum Account",
    createdAt: 1700000000000,
    type: "ethereum" as const,
    ethereumAddress: new EthAddress(TEST_ETH_ADDRESS_2_HEX),
    encryptedMasterKey: new Bytes(new Uint8Array([1, 2, 3, 4])),
    encryptionSalt: new Bytes(new Uint8Array([5, 6, 7, 8])),
    encryptedSecretSeed: new Bytes(new Uint8Array([9, 10, 11, 12])),
    swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
    ...overrides,
  }
}

export function createAgentAccount(
  overrides?: Partial<AgentAccount>,
): AgentAccount {
  return {
    id: new EthAddress(TEST_ETH_ADDRESS_HEX),
    name: "Test Agent Account",
    createdAt: 1700000000000,
    type: "agent" as const,
    swarmEncryptionKey: TEST_ENCRYPTION_KEY_HEX,
    ...overrides,
  }
}

export function createIdentity(overrides?: Partial<Identity>): Identity {
  return {
    id: "identity-1",
    accountId: new EthAddress(TEST_ETH_ADDRESS_HEX),
    name: "Default Identity",
    createdAt: 1700000000000,
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
    identityId: "identity-1",
    appSecret: "secret-should-be-stripped",
    ...overrides,
  }
}

export function createPostageStamp(
  overrides?: Partial<PostageStamp>,
): PostageStamp {
  return {
    accountId: TEST_ETH_ADDRESS_HEX,
    batchID: new BatchId(TEST_BATCH_ID_HEX),
    signerKey: new PrivateKey(TEST_PRIVATE_KEY_HEX),
    utilization: 0,
    usable: true,
    depth: 20,
    amount: 100000000,
    bucketDepth: 16,
    blockNumber: 12345678,
    immutableFlag: false,
    exists: true,
    createdAt: 1700000000000,
    ...overrides,
  }
}
