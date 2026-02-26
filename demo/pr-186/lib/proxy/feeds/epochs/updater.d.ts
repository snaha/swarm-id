/**
 * Basic Epoch Feed Updater
 *
 * Handles writing updates to epoch-based feeds by calculating the next
 * epoch and uploading chunks.
 */
import type { Bee, Stamper } from "@ethersphere/bee-js";
import { EthAddress, Topic, PrivateKey } from "@ethersphere/bee-js";
import type { EpochUpdater, EpochUpdateHints, EpochUpdateResult } from "./types";
/**
 * Basic updater for epoch-based feeds
 *
 * Implements Bee-compatible stateless epoch calculation.
 * Each update uses hints from the previous update to calculate the next epoch,
 * creating a proper epoch tree that Bee's finder can traverse.
 *
 * - First update (no hints): uses root epoch (level 32, start 0)
 * - Subsequent updates: calculates next epoch using the standard algorithm:
 *   - If new timestamp within previous epoch's range: dive to child
 *   - Else: jump to LCA(newTimestamp, prevTimestamp) and dive to child
 *
 * Implements the EpochUpdater interface.
 */
export declare class BasicEpochUpdater implements EpochUpdater {
    private readonly bee;
    private readonly topic;
    private readonly signer;
    constructor(bee: Bee, topic: Topic, signer: PrivateKey);
    /**
     * Update feed with a reference at given timestamp
     *
     * @param at - Unix timestamp for this update (seconds)
     * @param reference - 32 or 64-byte Swarm reference to store
     * @param stamper - Stamper object for stamping
     * @param encryptionKey - Optional encryption key for the update
     * @param hints - Optional hints from previous update for calculating epoch
     * @returns Update result with SOC address and epoch info for next update
     */
    update(at: bigint, reference: Uint8Array, stamper: Stamper, encryptionKey?: Uint8Array, hints?: EpochUpdateHints): Promise<EpochUpdateResult>;
    /**
     * Calculate the epoch for this update based on hints or auto-lookup
     *
     * When hints are provided, uses them for fast epoch calculation.
     * When no hints are provided, looks up the current feed state to calculate
     * the next epoch, preventing overwrites of previous updates.
     *
     * @param at - Timestamp for this update
     * @param hints - Optional hints from previous update
     * @param encryptionKey - Optional encryption key for looking up encrypted feeds
     * @returns Epoch to use for this update
     */
    private calculateEpoch;
    /**
     * Get the owner address (derived from signer)
     */
    getOwner(): EthAddress;
    /**
     * Upload a chunk for a specific epoch
     *
     * @param epoch - Epoch to upload to
     * @param at - Timestamp of this update
     * @param reference - 32 or 64-byte reference to store
     * @param stamper - Stamper object for stamping
     * @returns SOC chunk address for utilization tracking
     */
    private uploadEpochChunk;
}
//# sourceMappingURL=updater.d.ts.map