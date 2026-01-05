import { BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadEncryptedDataWithSigning } from "../proxy/upload-encrypted-data"
import { Topic, Reference, type BatchId } from "@ethersphere/bee-js"
import { serializeIdentityState } from "./serialization"
import { hexToUint8Array } from "../utils/key-derivation"
import type {
  StateSyncOptions,
  SyncResult,
  IdentityStateSnapshot,
} from "./types"

export class StateSyncManager {
  constructor(private options: StateSyncOptions) {}

  /**
   * Sync identity state to Swarm
   *
   * @param identityId - Identity to sync
   * @param state - State snapshot to upload
   * @param postageBatchId - Batch ID for stamping
   * @param encryptionKey - 32-byte encryption key (hex string)
   * @returns Sync result with reference and timestamp
   */
  async syncIdentity(
    identityId: string,
    state: IdentityStateSnapshot,
    postageBatchId: BatchId,
    encryptionKey: string,
  ): Promise<SyncResult> {
    try {
      // 1. Get identity signing key for feed
      const identityKey = await this.options.getIdentityKey(identityId)

      // 2. Serialize state
      const jsonData = serializeIdentityState(state)

      // 3. Upload encrypted data to Swarm
      const { reference } = await uploadEncryptedDataWithSigning(
        {
          bee: this.options.bee,
          postageBatchId: postageBatchId.toHex(),
        },
        jsonData,
        hexToUint8Array(encryptionKey), // encryption key
        undefined, // options
      )

      // 4. Update epoch feed with encrypted reference (64 bytes)
      const topic = Topic.fromString(`swarm-id-backup-v1:${identityId}`)
      const updater = new BasicEpochUpdater(
        this.options.bee,
        topic,
        identityKey,
      )

      const timestamp = BigInt(Math.floor(Date.now() / 1000))

      // Convert 128-char hex reference to 64-byte Uint8Array
      const refBytes = new Reference(reference).toUint8Array()

      await updater.update(timestamp, refBytes, postageBatchId.toHex())

      console.log(
        `[StateSync] Identity ${identityId} synced to ${reference} at ${timestamp}`,
      )

      return { status: "success", reference, timestamp }
    } catch (error) {
      console.error("[StateSync] Sync failed:", error)
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
