import { PrivateKey } from "@ethersphere/bee-js";
/**
 * Derive account backup key from account master key
 *
 * Used for signing account feed updates
 *
 * @param accountMasterKey - Account master key (hex string)
 * @param accountId - Account ID (EthAddress hex string)
 * @returns 32-byte account backup key (as hex string)
 */
export declare function deriveAccountBackupKey(accountMasterKey: string, accountId: string): Promise<string>;
/**
 * Derive account Swarm encryption key from account master key
 *
 * Used for encrypting account snapshot data before upload to Swarm
 *
 * @param accountMasterKey - Account master key (hex string)
 * @returns 32-byte encryption key (as hex string)
 */
export declare function deriveAccountSwarmEncryptionKey(accountMasterKey: string): Promise<string>;
/**
 * Convert backup key to PrivateKey for feed signing
 */
export declare function backupKeyToPrivateKey(backupKeyHex: string): PrivateKey;
//# sourceMappingURL=key-derivation.d.ts.map