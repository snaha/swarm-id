import { deriveSecret } from "../utils/key-derivation"
import { PrivateKey } from "@ethersphere/bee-js"

/**
 * Derive account backup key from account master key
 *
 * Used for signing account feed updates
 *
 * @param accountMasterKey - Account master key (hex string)
 * @param accountId - Account ID (EthAddress hex string)
 * @returns 32-byte account backup key (as hex string)
 */
export async function deriveAccountBackupKey(
  accountMasterKey: string,
  accountId: string,
): Promise<string> {
  return deriveSecret(accountMasterKey, `account:${accountId}`)
}

/**
 * Derive account Swarm encryption key from account master key
 *
 * Used for encrypting account snapshot data before upload to Swarm
 *
 * @param accountMasterKey - Account master key (hex string)
 * @returns 32-byte encryption key (as hex string)
 */
export async function deriveAccountSwarmEncryptionKey(
  accountMasterKey: string,
): Promise<string> {
  return deriveSecret(accountMasterKey, `swarm-encryption`)
}

/**
 * Convert backup key to PrivateKey for feed signing
 */
export function backupKeyToPrivateKey(backupKeyHex: string): PrivateKey {
  return new PrivateKey(backupKeyHex)
}
