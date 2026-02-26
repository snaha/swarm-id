/**
 * Basic Sequential Feed Updater
 *
 * Handles writing updates to sequential feeds by incrementing the index.
 */
import type { Bee, Stamper } from "@ethersphere/bee-js";
import { EthAddress, Topic, PrivateKey } from "@ethersphere/bee-js";
import type { SequentialUpdater } from "./types";
export declare class BasicSequentialUpdater implements SequentialUpdater {
    private readonly bee;
    private readonly topic;
    private readonly signer;
    private nextIndex;
    constructor(bee: Bee, topic: Topic, signer: PrivateKey);
    update(payload: Uint8Array, stamper: Stamper, encryptionKey?: Uint8Array): Promise<Uint8Array>;
    getOwner(): EthAddress;
    getState(): {
        nextIndex: bigint;
    };
    setState(state: {
        nextIndex: bigint;
    }): void;
    reset(): void;
    private makeIdentifier;
}
//# sourceMappingURL=updater.d.ts.map