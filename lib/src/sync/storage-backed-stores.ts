import { BatchId, EthAddress } from "@ethersphere/bee-js"
import {
  createAccountsStorageManager,
  createIdentitiesStorageManager,
  createConnectedAppsStorageManager,
  createPostageStampsStorageManager,
} from "../utils/storage-managers"
import { UtilizationAwareStamper } from "../utils/batch-utilization"
import type { UtilizationStoreDB } from "../storage/utilization-store"
import type {
  AccountsStoreInterface,
  IdentitiesStoreInterface,
  ConnectedAppsStoreInterface,
  PostageStampsStoreInterface,
  StamperOptions,
  FlushableStamper,
} from "./store-interfaces"
import type { PostageStamp } from "../schemas"

const accountsManager = createAccountsStorageManager()
const identitiesManager = createIdentitiesStorageManager()
const connectedAppsManager = createConnectedAppsStorageManager()
const postageStampsManager = createPostageStampsStorageManager()

export function createStorageBackedAccountsStore(): AccountsStoreInterface {
  return {
    getAccount(id: EthAddress) {
      const accounts = accountsManager.load()
      return accounts.find((a) => a.id.equals(id))
    },
  }
}

export function createStorageBackedIdentitiesStore(): IdentitiesStoreInterface {
  return {
    getIdentitiesByAccount(accountId: EthAddress) {
      const identities = identitiesManager.load()
      return identities.filter((i) => i.accountId.equals(accountId))
    },
  }
}

export function createStorageBackedConnectedAppsStore(): ConnectedAppsStoreInterface {
  return {
    getAppsByIdentityId(identityId: string) {
      const apps = connectedAppsManager.load()
      return apps.filter((app) => app.identityId === identityId)
    },
  }
}

export function createStorageBackedPostageStampsStore(
  utilizationStore?: UtilizationStoreDB,
): PostageStampsStoreInterface {
  return {
    getStamp(batchID: BatchId): PostageStamp | undefined {
      const stamps = postageStampsManager.load()
      return stamps.find((s) => s.batchID.equals(batchID))
    },

    getStampsByAccount(accountId: string): PostageStamp[] {
      const stamps = postageStampsManager.load()
      return stamps.filter((s) => s.accountId === accountId)
    },

    async getStamper(
      batchID: BatchId,
      options?: StamperOptions,
    ): Promise<FlushableStamper | undefined> {
      const stamp = this.getStamp(batchID)
      if (!stamp || !options || !utilizationStore) return undefined

      return UtilizationAwareStamper.create(
        stamp.signerKey.toUint8Array(),
        stamp.batchID,
        stamp.depth,
        utilizationStore,
        options.owner,
        options.encryptionKey,
      )
    },

    updateStampUtilization(batchID: BatchId, utilization: number): void {
      const stamps = postageStampsManager.load()
      const stamp = stamps.find((s) => s.batchID.equals(batchID))
      if (!stamp) {
        console.warn(
          "[StorageBackedStamps] Cannot update utilization: stamp not found",
        )
        return
      }

      stamp.utilization = utilization
      postageStampsManager.save(stamps)

      console.log(
        `[StorageBackedStamps] Updated utilization for ${batchID.toHex()}: ${utilization}%`,
      )
    },
  }
}
