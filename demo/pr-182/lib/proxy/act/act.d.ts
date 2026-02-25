/**
 * ACT (Access Control Tries) Data Structure
 *
 * Bee-compatible Simple Manifest (JSON) format for storing ACT entries.
 * The ACT stores lookup key -> encrypted access key mappings.
 *
 * Bee's ACT format is a Simple Manifest with structure:
 * {
 *   "entries": {
 *     "<lookupKeyHex>": {
 *       "reference": "<encryptedAccessKeyHex>",
 *       "metadata": {}
 *     }
 *   }
 * }
 *
 * All other data (publisher public key, encrypted reference, grantee list)
 * is stored separately and passed out-of-band.
 */
/**
 * Single ACT entry: lookup key + encrypted access key
 */
export interface ActEntry {
    lookupKey: Uint8Array;
    encryptedAccessKey: Uint8Array;
}
/**
 * Serialize ACT entries to JSON bytes (Bee-compatible Simple Manifest format)
 *
 * @param entries - Array of ACT entries
 * @returns JSON-encoded bytes
 */
export declare function serializeAct(entries: ActEntry[]): Uint8Array;
/**
 * Deserialize ACT entries from JSON bytes (Bee-compatible Simple Manifest format)
 *
 * @param data - JSON-encoded bytes
 * @returns Array of ACT entries
 */
export declare function deserializeAct(data: Uint8Array): ActEntry[];
/**
 * Find an ACT entry by lookup key
 *
 * @param entries - Array of ACT entries
 * @param lookupKey - 32-byte lookup key
 * @returns The entry if found, undefined otherwise
 */
export declare function findEntryByLookupKey(entries: ActEntry[], lookupKey: Uint8Array): ActEntry | undefined;
/**
 * Check if two public keys are equal
 */
export declare function publicKeysEqual(a: {
    x: Uint8Array;
    y: Uint8Array;
}, b: {
    x: Uint8Array;
    y: Uint8Array;
}): boolean;
/**
 * Helper to collect all ACT entries from JSON-encoded ACT data
 *
 * This is a convenience function for working with JSON ACT data directly from storage.
 *
 * @param actData - JSON-encoded ACT data from storage
 * @returns Array of ACT entries
 */
export declare function collectActEntriesFromJson(actData: Uint8Array): ActEntry[];
/**
 * Helper to find an ACT entry by lookup key from JSON-encoded ACT data
 *
 * This is a convenience function for working with JSON ACT data directly from storage.
 *
 * @param actData - JSON-encoded ACT data from storage
 * @param lookupKey - 32-byte lookup key to search for
 * @returns The encrypted access key if found, undefined otherwise
 */
export declare function findActEntryByKey(actData: Uint8Array, lookupKey: Uint8Array): Uint8Array | undefined;
//# sourceMappingURL=act.d.ts.map