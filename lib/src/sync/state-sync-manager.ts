import { BasicEpochUpdater } from "../proxy/feeds/epochs"
import { uploadEncryptedDataWithSigning } from "../proxy/upload-encrypted-data"
import { Topic, Reference } from "@ethersphere/bee-js"
import { serializeAccountState } from "./serialization"
import { hexToUint8Array } from "../utils/key-derivation"
import type {
  StateSyncOptions,
  SyncResult,
  AccountStateSnapshot,
} from "./types"
import { PostageStamp } from "../types"

// Topic prefix for sync feeds
export const ACCOUNT_SYNC_TOPIC_PREFIX = "swarm-id-backup-v1:account"

export class StateSyncManager {
  constructor(private options: StateSyncOptions) {}

  /**
   * Sync account state to Swarm
   *
   * @param accountId - Account ID (EthAddress hex string)
   * @param state - Account state snapshot to upload
   * @param postageBatchId - Batch ID for stamping
   * @param encryptionKey - 32-byte encryption key (hex string)
   * @returns Sync result with reference and timestamp
   */
  async syncAccount(
    accountId: string,
    state: AccountStateSnapshot,
    postageStamp: PostageStamp,
    encryptionKey: string,
  ): Promise<SyncResult> {
    const startTime = performance.now()
    console.log(
      `[StateSyncManager ${new Date().toISOString()}] Starting account sync for ${accountId}`,
    )

    try {
      // 1. Get account signing key for feed
      if (!this.options.getAccountKey) {
        throw new Error("getAccountKey is required for account sync")
      }
      const accountKey = await this.options.getAccountKey(accountId)
      console.log(
        `[StateSyncManager ${new Date().toISOString()}] Account key retrieved (+${(performance.now() - startTime).toFixed(2)}ms)`,
      )

      // 2. Serialize account state
      const jsonData = serializeAccountState(state)
      console.log(
        `[StateSyncManager ${new Date().toISOString()}] State serialized, ${jsonData.length} bytes (+${(performance.now() - startTime).toFixed(2)}ms)`,
      )

      // Get stamper from provided factory
      const stamper = await this.options.getStamper(postageStamp)
      console.log(
        "[StateSyncManager] Using provided stamper with loaded bucket state",
      )

      // 3. Upload encrypted data to Swarm
      console.log(
        `[StateSyncManager ${new Date().toISOString()}] Starting encrypted upload... (+${(performance.now() - startTime).toFixed(2)}ms)`,
      )
      const uploadResult = await uploadEncryptedDataWithSigning(
        {
          bee: this.options.bee,
          stamper,
        },
        jsonData,
        hexToUint8Array(encryptionKey), // encryption key
        undefined, // options
      )
      console.log(
        `[StateSyncManager ${new Date().toISOString()}] Upload completed, ${uploadResult.chunkAddresses.length} chunks (+${(performance.now() - startTime).toFixed(2)}ms)`,
      )

      // Collect chunk addresses for utilization tracking
      const allChunkAddresses = [...uploadResult.chunkAddresses]

      // 4. WAIT FOR UTILIZATION UPLOAD (optional, browser-only)
      if (this.options.utilization?.onUtilizationUpdate) {
        console.log(
          `[StateSyncManager ${new Date().toISOString()}] Waiting for utilization upload... (+${(performance.now() - startTime).toFixed(2)}ms)`,
        )

        try {
          await this.options.utilization.onUtilizationUpdate(
            accountId,
            allChunkAddresses,
          )

          // Optionally log utilization percentage
          if (this.options.utilization.getUtilizationPercentage) {
            const percentage =
              await this.options.utilization.getUtilizationPercentage(accountId)
            console.log(
              `[StateSyncManager ${new Date().toISOString()}] Utilization: ${percentage.toFixed(2)}% (+${(performance.now() - startTime).toFixed(2)}ms)`,
            )
          }

          console.log(
            `[StateSyncManager ${new Date().toISOString()}] Utilization upload complete (+${(performance.now() - startTime).toFixed(2)}ms)`,
          )
        } catch (error) {
          // Don't fail sync if utilization fails
          console.error(
            `[StateSyncManager ${new Date().toISOString()}] Utilization upload failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
            error,
          )
          console.warn(
            `[StateSyncManager ${new Date().toISOString()}] Continuing with feed update anyway...`,
          )
        }
      }

      // 5. UPDATE EPOCH FEED (after utilization completes)
      const topic = Topic.fromString(
        `${ACCOUNT_SYNC_TOPIC_PREFIX}:${accountId}`,
      )
      const updater = new BasicEpochUpdater(this.options.bee, topic, accountKey)

      const timestamp = BigInt(Math.floor(Date.now() / 1000))

      // Convert 128-char hex reference to 64-byte Uint8Array
      const refBytes = new Reference(uploadResult.reference).toUint8Array()

      // Update epoch feed and get SOC chunk address
      console.log(
        `[StateSyncManager ${new Date().toISOString()}] Updating epoch feed... (+${(performance.now() - startTime).toFixed(2)}ms)`,
      )
      const socAddress = await updater.update(timestamp, refBytes, stamper)
      console.log(
        `[StateSyncManager ${new Date().toISOString()}] Epoch feed updated (+${(performance.now() - startTime).toFixed(2)}ms)`,
      )

      // Add SOC chunk to tracked addresses
      allChunkAddresses.push(socAddress)

      console.log(
        `[StateSyncManager ${new Date().toISOString()}] ✅ Account ${accountId} synced to ${uploadResult.reference} (TOTAL: ${(performance.now() - startTime).toFixed(2)}ms)`,
      )

      return {
        status: "success",
        reference: uploadResult.reference,
        timestamp,
        chunkAddresses: allChunkAddresses,
      }
    } catch (error) {
      console.error(
        `[StateSyncManager ${new Date().toISOString()}] Account sync failed (+${(performance.now() - startTime).toFixed(2)}ms):`,
        error,
      )
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
