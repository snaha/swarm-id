/**
 * Basic Epoch Feed Updater
 *
 * Handles writing updates to epoch-based feeds by calculating the next
 * epoch and uploading chunks.
 */
import type { Bee, Stamper } from '@ethersphere/bee-js';
import { EthAddress, Topic, PrivateKey } from '@ethersphere/bee-js';
import { EpochIndex } from './epoch';
import type { EpochUpdater } from './types';
/**
 * Basic updater for epoch-based feeds
 *
 * Maintains state of the last update and calculates the next epoch
 * for new updates.
 *
 * Implements the EpochUpdater interface.
 */
export declare class BasicEpochUpdater implements EpochUpdater {
    private readonly bee;
    private readonly topic;
    private readonly signer;
    private lastUpdate;
    private lastEpoch;
    constructor(bee: Bee, topic: Topic, signer: PrivateKey);
    /**
     * Update feed with a reference at given timestamp
     *
     * @param at - Unix timestamp for this update (seconds)
     * @param reference - 32 or 64-byte Swarm reference to store
     * @param stamper - Stamper object for stamping
     * @returns SOC chunk address for utilization tracking
     */
    update(at: bigint, reference: Uint8Array, stamper: Stamper): Promise<Uint8Array>;
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
    /**
     * Reset updater state (useful for testing or reinitialization)
     */
    reset(): void;
    /**
     * Get current state (for persistence/debugging)
     */
    getState(): {
        lastUpdate: bigint;
        lastEpoch: EpochIndex | undefined;
    };
    /**
     * Restore state (from persistence)
     */
    setState(state: {
        lastUpdate: bigint;
        lastEpoch?: EpochIndex;
    }): void;
}
//# sourceMappingURL=updater.d.ts.map