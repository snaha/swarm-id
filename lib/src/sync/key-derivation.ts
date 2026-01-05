import { deriveSecret } from "../utils/key-derivation"
import { PrivateKey } from "@ethersphere/bee-js"

/**
 * Derive identity backup key from account master key
 *
 * Uses existing deriveSecret() with "identity:" prefix
 *
 * @param accountMasterKey - Account master key (hex string)
 * @param identityId - Identity UUID
 * @returns 32-byte identity backup key (as hex string)
 */
export async function deriveIdentityBackupKey(
  accountMasterKey: string,
  identityId: string,
): Promise<string> {
  return deriveSecret(accountMasterKey, `identity:${identityId}`)
}

/**
 * Derive identity encryption key (for uploading encrypted data)
 *
 * Uses existing deriveSecret() with "identity-encryption:" prefix
 *
 * @param accountMasterKey - Account master key (hex string)
 * @param identityId - Identity UUID
 * @returns 32-byte encryption key (as hex string)
 */
export async function deriveIdentityEncryptionKey(
  accountMasterKey: string,
  identityId: string,
): Promise<string> {
  return deriveSecret(accountMasterKey, `identity-encryption:${identityId}`)
}

/**
 * Convert backup key to PrivateKey for feed signing
 */
export function backupKeyToPrivateKey(backupKeyHex: string): PrivateKey {
  return new PrivateKey(backupKeyHex)
}
