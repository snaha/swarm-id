// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ParentToIframeMessage,
  ParentIdentifyMessage,
  IframeToParentMessage,
  ButtonConfig,
  UploadDataMessage,
  DownloadDataMessage,
  DeriveAppSecretMessage,
  UploadFileMessage,
  DownloadFileMessage,
  UploadChunkMessage,
  DownloadChunkMessage,
  IsConnectedMessage,
  GetNodeInfoMessage,
  GsocMineMessage,
  GsocSendMessage,
  SocUploadMessage,
  SocRawUploadMessage,
  SocDownloadMessage,
  SocRawDownloadMessage,
  SocGetOwnerMessage,
  EpochFeedDownloadReferenceMessage,
  EpochFeedUploadReferenceMessage,
  FeedGetOwnerMessage,
  SequentialFeedGetOwnerMessage,
  SequentialFeedDownloadPayloadMessage,
  SequentialFeedDownloadRawPayloadMessage,
  SequentialFeedDownloadReferenceMessage,
  SequentialFeedUploadPayloadMessage,
  SequentialFeedUploadRawPayloadMessage,
  SequentialFeedUploadReferenceMessage,
  ActUploadDataMessage,
  ActDownloadDataMessage,
  ActAddGranteesMessage,
  ActRevokeGranteesMessage,
  ActGetGranteesMessage,
  GetPostageBatchesMessage,
  GetPostageBatchMessage,
  CreateFeedManifestMessage,
  AppMetadata,
  PostageStamp,
  PostageBatch,
  ConnectedApp,
  ConnectionIdentity,
  ConnectionInfo,
} from "./types"
import {
  ParentToIframeMessageSchema,
  ParentIdentifyMessageSchema,
  PopupToIframeMessageSchema,
  STORAGE_CHALLENGE_KEY,
  STORAGE_KEY_NETWORK_SETTINGS,
  leaseCacheStorageKey,
} from "./types"
import type { PopupToIframeMessage } from "./types"
import {
  Bee,
  BatchId,
  EthAddress,
  PrivateKey,
  Identifier,
  Topic,
  MantarayNode,
  NULL_ADDRESS,
} from "@ethersphere/bee-js"
import { makeContentAddressedChunk } from "./chunk"
import type { BeeRequestOptions } from "@ethersphere/bee-js"
import {
  uploadData,
  uploadSOC,
  uploadChunk,
  type UploadTarget,
} from "./proxy/upload"
import {
  downloadDataWithChunkAPI,
  downloadSOC,
  downloadEncryptedSOC,
} from "./proxy/download-data"
import type { UploadProgress } from "./proxy/types"
import { StampWorkerPool } from "./proxy/stamp-worker-pool"
import {
  loadMantarayTreeWithChunkAPI,
  saveMantarayTree,
} from "./proxy/mantaray"
import { createFeedManifestDirect } from "./proxy/feed-manifest"
import { resolveStampForApp } from "./utils/postage-stamp-association"
import {
  accountStateToDeviceView,
  publishDeviceState,
  readRoster,
} from "./sync"
import { mergeDevicesList } from "./sync/merge-snapshot"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { UtilizationStoreDB } from "./storage/utilization-store"
import type { PartitionLeaseStateSnapshot } from "./sync/partition-lease"
import { BatchWriteCoordinator } from "./sync/batch-write-coordinator"
import {
  getOrCreateDeviceId,
  mergeDevices,
  detectDeviceName,
} from "./utils/device-id"
import {
  createNetworkSettingsStorageManager,
  createAccountsStorageManager,
} from "./utils/storage-managers"
import {
  hexToUint8Array,
  uint8ArrayToHex,
  deriveSecret,
  deriveSwarmEncryptionKey,
} from "./utils/key-derivation"
import { generatedAvatar } from "./utils/avatar"
import { connectionInfoEqual } from "./utils/connection-info"
import {
  activeDeviceIds,
  KNOWN_DEVICE_MAX_AGE_MS,
} from "./utils/active-devices"
import {
  createAsyncEpochFinder,
  createEpochUpdater,
} from "./proxy/feeds/epochs"
import { createAsyncSequentialFinder } from "./proxy/feeds/sequence"
import { Binary } from "cafe-utility"
import {
  calculateTTLSeconds,
  fetchBatchDetails,
  fetchSwarmPrice,
  type BatchDetails,
} from "./utils/ttl"
import {
  fetchAuthoritativeBatchTTL,
  POSTAGE_STAMP_CONTRACT_ADDRESS,
} from "./utils/postage-contract"
import { withTimeout } from "./utils/promise"
import { tryCreateTag } from "./utils/tag"
import { withBatchStateLock } from "./utils/account-write-lock"
import {
  DEFAULT_BEE_NODE_URL,
  DEFAULT_GNOSIS_RPC_URL,
  UtilizationUpdateMessageSchema,
  isSignedOutAccount,
  type AccountStateSnapshot,
  type SignedInAccount,
} from "./schemas"
import { buildAuthUrl } from "./utils/url"
import {
  createActForContent,
  decryptActReference,
  addGranteesToAct,
  revokeGranteesFromAct,
  getGranteesFromAct,
  parseCompressedPublicKey,
  publicKeyFromPrivate,
  compressPublicKey,
} from "./proxy/act"

/**
 * Debounce window for proxy-side account-state publishing. Coalesces a burst of
 * triggers (lease acquisition + storage changes) into a single feed write.
 */
const PUBLISH_DEBOUNCE_MS = 1500

/** Min interval between pre-acquire device-registry pulls (throttles the
 *  slot-wait loop's repeated acquires from hammering the feed). */
const DEVICE_REGISTRY_REFRESH_THROTTLE_MS = 8_000

const DEFAULT_ACT_FILENAME = "index.bin"
const DEFAULT_ACT_CONTENT_TYPE = "application/octet-stream"
const SEQUENTIAL_INDEX_LOOKUP_TIMEOUT_MS = 2000

/**
 * Cap on the per-stamp live enrichment (Bee /stamps + chain TTL + price) in
 * `getPostageBatches`. Well under the client's request timeout, so a hung RPC
 * degrades to the stored snapshot instead of failing the whole call.
 */
const STAMP_ENRICH_TIMEOUT_MS = 10_000

/**
 * localStorage key holding optional partition-coordination timing overrides
 * (`{ guardWindowMs?, guardPollMs?, readTimeoutMs? }`). Lets the gateway's
 * propagation tuning be adjusted at runtime (set by the /dev "Partition tuning"
 * panel) and picked up on the next connect — no rebuild. Absent → code defaults.
 */
const PARTITION_TUNING_KEY = "swarm-id-partition-tuning"

function readPartitionTuningOverride():
  | { guardWindowMs?: number; guardPollMs?: number; readTimeoutMs?: number }
  | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined
    const raw = localStorage.getItem(PARTITION_TUNING_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const pick = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
    const o = parsed as Record<string, unknown>
    return {
      guardWindowMs: pick(o.guardWindowMs),
      guardPollMs: pick(o.guardPollMs),
      readTimeoutMs: pick(o.readTimeoutMs),
    }
  } catch {
    return undefined
  }
}

/**
 * Swarm ID Proxy - Runs inside the iframe
 *
 * Responsibilities:
 * - Receive app-specific secrets from auth popup
 * - Store secrets in partitioned localStorage
 * - Proxy Bee API calls from parent dApp
 * - Augment requests with authentication
 * - Return responses to parent dApp
 */
export class SwarmIdProxy {
  private parentOrigin: string | undefined
  private parentIdentified: boolean = false
  private authenticated: boolean = false
  private authLoading: boolean = true // Start in loading state
  private appSecret: string | undefined
  private postageBatchId: string | undefined
  private signerKey: string | undefined
  private stamper: UtilizationAwareStamper | undefined
  /**
   * Hash of `<owner>-<encryptionKey>` that the current `stamper` was built
   * with. Account-level inputs are baked into `UtilizationAwareStamper` at
   * construction, so when the underlying account changes (e.g. a local
   * account migrates to a synced one) we need to detect that even if the
   * postage stamp's batch/signer didn't change, and rebuild the stamper.
   */
  private stamperAccountFingerprint: string | undefined
  /**
   * Per-batch stamper cache, keyed by batch id hex — the default binding's
   * stamper plus one per targeted batch (`UploadOptions.batchID`), each with
   * its signing key and (lazily) its parallel-signing worker pool. Stampers
   * bake in account inputs (owner / encryption key), so an account
   * fingerprint change clears the whole map; a tombstoned stamp evicts its
   * entry. Targeted writes read stampers from here — they never touch the
   * default binding fields above.
   */
  private readonly stampEntries = new Map<
    string,
    {
      stamper: UtilizationAwareStamper
      signerKey: string
      workerPool?: StampWorkerPool
    }
  >()
  /**
   * In-flight `createStamperUnderBatchLock` calls, keyed `<batchId>:<signer>`,
   * so concurrent callers share one build instead of racing to create two live
   * stampers for one batch. Entries are removed as soon as the build settles.
   */
  private readonly stamperBuilds = new Map<
    string,
    Promise<UtilizationAwareStamper>
  >()
  private storagePartitioned: boolean = false
  private pendingChallenge: string | undefined
  private storagePartitionedIdentity: ConnectionIdentity | undefined
  private utilizationStore: UtilizationStoreDB | undefined
  private beeApiUrl: string
  private gnosisRpcUrl: string
  private postageStampContractAddress: string
  private authButtonContainer: HTMLElement | undefined
  private buttonConfig: ButtonConfig | undefined
  private popupMode: "popup" | "window" = "window"
  private appMetadata: AppMetadata | undefined
  private bee: Bee
  private unsubscribeStorageListeners: Array<() => void> = []
  private storageWorkQueue: Promise<void> = Promise.resolve()
  private lastConnectionInfo: ConnectionInfo | undefined
  private isConnecting: boolean = false
  private parentWindow: WindowProxy | undefined
  private utilizationChannel: BroadcastChannel
  private subsidisedGatewayUrl: string | undefined
  /**
   * The write path (lock + partition lease + stamp flush) for the current
   * account+batch. Constructed in `initializeStamper` once the stamper and
   * account context are known; undefined before auth / after disconnect. The
   * proxy delegates all writes to it via `withModeAwareWriteLock`.
   */
  private coordinator: BatchWriteCoordinator | undefined
  /**
   * Debounce timer + in-flight guard for proxy-side account-state publishing.
   * The proxy publishes the account snapshot to the shared sync feed when it
   * first acquires a partition (so the device announces itself — see #336
   * motivation #4) and when account state changes while a lease is held.
   */
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private publishInFlight: boolean = false
  /**
   * Why the next debounced publish was scheduled. `"acquired"` (announce on
   * lease acquisition) is gated on this device not yet being in the feed, so a
   * plain reload doesn't republish. `"change"` (account-state delta) always
   * publishes. `"change"` dominates a coalesced burst — a real delta must never
   * be skipped just because an acquisition was also pending.
   */
  private publishReason: "acquired" | "change" | undefined
  /**
   * This device's identity, captured ONCE at authentication and reused for
   * every lease operation. Never re-read from `getOrCreateDeviceId()` mid-
   * session, so acquire / refresh / validate always agree on one identity.
   */
  private deviceId: string | undefined

  constructor(config?: ProxyConfig) {
    // Load Bee API URL from network settings, falling back to default
    const networkSettings = createNetworkSettingsStorageManager().load()
    this.beeApiUrl = networkSettings?.beeNodeUrl || DEFAULT_BEE_NODE_URL
    this.gnosisRpcUrl = networkSettings?.gnosisRpcUrl || DEFAULT_GNOSIS_RPC_URL
    // PostageStamp contract address for on-chain TTL reads. The host app
    // supplies this from a build-time env so local dev can point at the
    // bee-compose anvil deployment; defaults to the Gnosis mainnet contract.
    this.postageStampContractAddress =
      config?.postageStampContractAddress || POSTAGE_STAMP_CONTRACT_ADDRESS
    this.bee = new Bee(this.beeApiUrl)
    this.setupMessageListener()
    this.setupStorageListeners()

    // Initialize multi-tab coordination via BroadcastChannel
    this.utilizationChannel = new BroadcastChannel("swarm-id-utilization")
    this.setupUtilizationListener()

    // Announce readiness to parent window immediately
    // This signals that our message listener is ready to receive parentIdentify
    this.announceReady()
  }

  /**
   * Subscribe to shared localStorage changes that can affect the dApp-visible
   * ConnectionInfo (auth state, identity, postage stamps, account type).
   *
   * - `connectedApps` drives auth transitions (new connection / identity switch /
   *   disconnect) and triggers `authSuccess` / `disconnectResponse` to the parent.
   * - `identities`, `accounts`, `postageStamps` may change the derived
   *   ConnectionInfo without flipping auth state (e.g. rename, default-stamp
   *   change, local→synced migration). On change we re-derive ConnectionInfo
   *   and emit `connectionInfoChanged` if it actually differs.
   *
   * Note: We always set up these listeners, even when storage might be partitioned.
   * In some browsers/configurations (like localhost development), storage events
   * work between same-origin windows even in iframes. If storage IS partitioned,
   * the listeners simply won't fire, and we fall back to postMessage from the popup.
   */
  private setupStorageListeners(): void {
    // Avoid duplicate subscriptions
    if (this.unsubscribeStorageListeners.length > 0) {
      return
    }

    // Serialize handler invocations so rapid storage events (or concurrent
    // events across stores) don't interleave `refreshStampFromStorage` /
    // `initializeStamper` runs — those mutate shared `stamper`/`postageBatchId`
    // state and races would produce inconsistent ConnectionInfo emissions.
    // Rejections are caught and logged so one failure doesn't break the chain.
    const enqueue = (where: string, work: () => Promise<void>): void => {
      this.enqueueWork(work).catch((error: unknown) => {
        console.error(`[Proxy] ${where} failed:`, error)
      })
    }

    // The account is the single nested document of record (it owns its
    // connected apps and postage stamps), so one subscription covers every
    // change that can affect auth or derived ConnectionInfo.
    const accountsManager = createAccountsStorageManager()
    this.unsubscribeStorageListeners.push(
      accountsManager.subscribe(() => {
        enqueue("handleAccountStorageChange", () =>
          this.handleAccountStorageChange(),
        )
      }),
    )

    // The user can change the Bee node URL at runtime via the trusted UI's
    // network-settings dialog. That localStorage write fires a `storage` event
    // in this same-origin dApp iframe — repoint the Bee client so the newly
    // configured node is in effect before the next write (#515). The
    // network-settings manager has no `subscribe`, so listen for the raw event.
    if (typeof window !== "undefined") {
      const onNetworkSettingsChange = (event: StorageEvent): void => {
        if (event.key !== STORAGE_KEY_NETWORK_SETTINGS) {
          return
        }
        this.applyNetworkSettings()
      }
      window.addEventListener("storage", onNetworkSettingsChange)
      this.unsubscribeStorageListeners.push(() =>
        window.removeEventListener("storage", onNetworkSettingsChange),
      )
    }
  }

  /**
   * Serialize `work` on the shared queue that guards all mutations of the
   * stamper/coordinator binding: storage-event handlers, network-settings
   * rebuilds, and stamped writes all run here one at a time, so none of them
   * can swap the binding under another. The returned promise settles with the
   * work's result; a rejection propagates to the caller but never wedges the
   * queue.
   */
  private enqueueWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.storageWorkQueue.then(work)
    this.storageWorkQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Re-read network settings and repoint the Bee client at the configured node.
   * `beeApiUrl` / `gnosisRpcUrl` are read fresh per call by the TTL/contract
   * helpers, so only the cached `this.bee` needs rebuilding. No-op when the Bee
   * URL is unchanged, so an RPC-only change doesn't churn the client mid-op.
   */
  private applyNetworkSettings(): void {
    const settings = createNetworkSettingsStorageManager().load()
    this.gnosisRpcUrl = settings?.gnosisRpcUrl || DEFAULT_GNOSIS_RPC_URL

    const beeNodeUrl = settings?.beeNodeUrl || DEFAULT_BEE_NODE_URL
    if (beeNodeUrl === this.beeApiUrl) {
      return
    }
    this.beeApiUrl = beeNodeUrl

    // A custom node disables the dApp-provided subsidised gateway (mirrors the
    // parentIdentify override). ponytail: reverting to the default URL won't
    // re-enable a dropped subsidised gateway — that needs a fresh parentIdentify
    // (dApp reload); rare enough to not build for.
    if (this.beeApiUrl !== DEFAULT_BEE_NODE_URL) {
      this.subsidisedGatewayUrl = undefined
    }

    this.bee = new Bee(
      this.isSubsidisedModeActive()
        ? this.subsidisedGatewayUrl!
        : this.beeApiUrl,
    )

    // The write coordinator captured a Bee client when it was built, so
    // repointing `this.bee` alone would leave stamped uploads and lease SOCs
    // on the old node. Rebuild the stamper/coordinator on the shared queue
    // (so it can't swap under an in-flight write), then re-emit
    // ConnectionInfo — dropping the subsidised gateway above may have flipped
    // `uploadMode`/`canUpload` for the dApp.
    this.enqueueWork(async () => {
      await this.rebindActiveStamp()
      this.emitConnectionInfoIfChanged()
    }).catch((error: unknown) => {
      console.error("[Proxy] Rebind after network change failed:", error)
    })
  }

  /**
   * Handle changes to the nested account document (triggered by storage events
   * from other windows). Covers auth transitions (connect / secret change /
   * disconnect) AND derived-ConnectionInfo changes (default-stamp change, new
   * stamp purchased, account rename) — all of which now live in one document.
   */
  private async handleAccountStorageChange(): Promise<void> {
    if (!this.parentOrigin) {
      return
    }

    const connection = this.findConnectionForParent()

    if (connection) {
      const { app } = connection
      if (!this.authenticated || app.appSecret !== this.appSecret) {
        // New connection, or the connected account / secret changed.
        await this.authenticateFromStorage(app)
      } else {
        // Same connection — related metadata (default stamp, per-app batch
        // override, rename) may have changed.
        if (!this.storagePartitioned) {
          await this.refreshStampFromStorage()
        }
        this.emitConnectionInfoIfChanged()
      }

      // If we hold a partition, propagate the account-state change to peers.
      // Debounced so a burst collapses into one feed write.
      if (this.coordinator?.currentPartition !== undefined) {
        this.schedulePublish("change")
      }
    } else if (this.authenticated && !this.storagePartitioned) {
      // No valid connection in storage, but we're authenticated - disconnect.
      // Skip when storage is partitioned: the iframe can't see connected apps,
      // but auth was established via postMessage. `clearAuthData` emits the
      // ConnectionInfo update; no need to do so again.
      this.clearAuthData()
      this.sendToParent({
        type: "disconnectResponse",
        requestId: "storage-event",
        success: true,
      })
    }
  }

  /**
   * Re-resolve postage stamp and account inputs for the current connection
   * from shared storage. Reinitializes the stamper if the batch, signer
   * key, or account-level inputs (owner / encryption key) changed — the
   * last case handles e.g. local→synced account migration where the
   * postage stamp is unchanged but the underlying account isn't.
   */
  private async refreshStampFromStorage(): Promise<void> {
    if (this.storagePartitioned) {
      return
    }

    // Cached target stampers whose batch was tombstoned/removed must not
    // serve a later targeted write.
    this.pruneStampEntries()

    const stamp = this.lookupPostageStampForApp()
    const nextBatchId = stamp?.batchID.toHex()
    const nextSignerKey = stamp?.signerKey.toHex()
    const account = stamp ? await this.lookupAccountForApp() : undefined
    const nextAccountFingerprint = account
      ? `${account.owner.toHex()}-${uint8ArrayToHex(account.encryptionKey)}`
      : undefined

    if (
      nextBatchId === this.postageBatchId &&
      nextSignerKey === this.signerKey &&
      nextAccountFingerprint === this.stamperAccountFingerprint
    ) {
      return
    }

    if (stamp) {
      // Account-level inputs are baked into every cached stamper, so a
      // fingerprint change (e.g. local→synced migration) invalidates the
      // whole cache, not just the default binding.
      if (nextAccountFingerprint !== this.stamperAccountFingerprint) {
        this.clearStampEntries()
      }
      await this.bindStamp(stamp)
    } else if (
      this.postageBatchId &&
      this.findOwnedStamp(this.postageBatchId)
    ) {
      // No default resolves, but the bound batch is still owned — e.g. it was
      // promoted from a targeted write on an account whose default pointer is
      // gone. Keep it; clearing would strand uploads for no reason.
      return
    } else {
      this.clearDefaultBinding()
    }
  }

  /**
   * Clear the default stamp binding (all four fields — always together) and
   * tear down the write coordinator with it.
   *
   * The coordinator's lease stamper IS the binding's stamper, so a coordinator
   * that outlives the binding keeps heartbeating lock/intent/occupancy SOCs
   * under a batch this proxy no longer serves (e.g. the default drive was
   * deleted in the trusted UI). It also strands `resolveUploadStamper`, whose
   * promotion path is gated on `!this.coordinator`: a later targeted write
   * would join that stale lease rather than rebind. Only the genuine
   * "no usable stamp" paths reach here — `bindStamp` sets its fields directly.
   */
  private clearDefaultBinding(): void {
    this.postageBatchId = undefined
    this.signerKey = undefined
    this.stamper = undefined
    this.stamperAccountFingerprint = undefined
    this.coordinator?.teardown()
    this.coordinator = undefined
  }

  /**
   * Authenticate using data from connected apps storage
   */
  private async authenticateFromStorage(
    connectedApp: ConnectedApp,
  ): Promise<void> {
    this.appSecret = connectedApp.appSecret
    this.authenticated = true
    this.storagePartitioned = false
    this.storagePartitionedIdentity = undefined
    this.authLoading = false
    this.isConnecting = false
    // Capture the device identity once, now, while we can read first-party
    // localStorage. Reused for every lease op so the identity never shifts
    // mid-session.
    this.deviceId = getOrCreateDeviceId()

    // Look up postage stamp. When switching identities, the new identity may
    // not have a stamp at all — explicitly clear any prior stamper state
    // (including cached target-batch stampers, which bake in the previous
    // account's inputs) so we don't emit a snapshot claiming `user-stamp`
    // mode with the previous identity's stamp.
    this.clearStampEntries()
    const stamp = this.lookupPostageStampForApp()
    if (stamp) {
      await this.bindStamp(stamp)
    } else {
      this.clearDefaultBinding()
    }

    this.showAuthButton()
    this.sendToParent({
      type: "authSuccess",
      origin: this.parentOrigin!,
    })
    this.emitConnectionInfoIfChanged()
  }

  /**
   * Handle messages from the auth popup (same-origin postMessage).
   * Used as storage partitioning fallback when storage events don't fire due to partitioning.
   */
  private async handlePopupMessage(
    message: PopupToIframeMessage,
  ): Promise<void> {
    if (message.type === "setSecret") {
      // Validate the appOrigin matches our parent
      if (message.appOrigin !== this.parentOrigin) {
        console.warn(
          "[Proxy] setSecret appOrigin mismatch:",
          message.appOrigin,
          "!==",
          this.parentOrigin,
        )
        return
      }

      // Verify challenge matches what we generated in openAuthPopup()
      if (
        !this.pendingChallenge ||
        message.challenge !== this.pendingChallenge
      ) {
        console.warn("[Proxy] setSecret challenge mismatch — ignoring")
        return
      }

      // Clean up challenge
      this.pendingChallenge = undefined
      localStorage.removeItem(STORAGE_CHALLENGE_KEY)

      // Authenticate in storage-partitioned mode (no stamps available via postMessage)
      this.appSecret = message.data.secret
      this.authenticated = true
      this.storagePartitioned = true
      this.authLoading = false
      this.isConnecting = false
      this.deviceId = getOrCreateDeviceId()

      // Store identity info from message (can't read from partitioned localStorage)
      if (
        message.data.identityId &&
        message.data.identityName &&
        message.data.identityAddress
      ) {
        this.storagePartitionedIdentity = {
          id: message.data.identityId,
          name: message.data.identityName,
          address: message.data.identityAddress,
          publicKey: message.data.identityPublicKey,
          avatar: generatedAvatar(message.data.identityId),
        }
      }

      // No stamp lookup — localStorage is partitioned, stamps not accessible
      this.clearDefaultBinding()

      this.showAuthButton()
      this.sendToParent({
        type: "authSuccess",
        origin: this.parentOrigin!,
      })
      this.emitConnectionInfoIfChanged()
    }
  }

  /**
   * Clean up resources when the proxy is destroyed.
   * Call this method when the proxy iframe is being unloaded.
   */
  destroy(): void {
    for (const unsubscribe of this.unsubscribeStorageListeners) {
      unsubscribe()
    }
    this.unsubscribeStorageListeners = []

    // Release the partition lease (best-effort) so peers see this device
    // vacate its partition promptly.
    this.coordinator?.teardown()
    this.coordinator = undefined
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer)
      this.publishTimer = undefined
    }

    // Terminate cached stampers' worker pools.
    this.clearStampEntries()

    // Clean up utilization channel
    this.utilizationChannel.close()
  }

  /**
   * Setup listener for utilization updates from other tabs.
   * When another tab completes a write, it broadcasts an update.
   * This tab applies the delta update directly from the message.
   */
  private setupUtilizationListener(): void {
    this.utilizationChannel.onmessage = (event) => {
      try {
        const result = UtilizationUpdateMessageSchema.safeParse(event.data)
        if (!result.success) return
        // Route by the message's batch into the per-batch stamper cache (the
        // default binding's stamper is an entry too) — a targeted batch's
        // update must not be dropped just because it isn't the default.
        const entry = this.stampEntries.get(result.data.batchId)
        if (entry) {
          // Apply delta update directly - no IndexedDB read needed
          entry.stamper.applyUtilizationUpdate(result.data.buckets)
        }
      } catch (error) {
        console.error("[Proxy] Failed to apply utilization update:", error)
      }
    }
  }

  /**
   * Create an onProgress callback for upload operations.
   * Returns undefined if progress reporting is disabled.
   */
  private createProgressCallback(
    event: MessageEvent,
    requestId: string,
    enableProgress: boolean | undefined,
  ): ((progress: UploadProgress) => void) | undefined {
    if (!enableProgress) return undefined
    return (progress: UploadProgress) => {
      this.postMessage(event, {
        type: "uploadProgress",
        requestId,
        total: progress.total,
        processed: progress.processed,
      })
    }
  }

  /**
   * Announce that proxy is ready to receive messages
   * Broadcasts to parent with wildcard origin since we don't know parent origin yet
   */
  private announceReady(): void {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: "proxyInitialized" },
        "*", // Wildcard since we don't know parent origin yet
      )
    }
  }

  /**
   * Get the stored postage batch ID
   */
  getPostageBatchId(): string | undefined {
    return this.postageBatchId
  }

  /**
   * Get the stored signer key
   */
  getSignerKey(): string | undefined {
    return this.signerKey
  }

  /**
   * Initialize the Stamper for client-side signing
   * Uses UtilizationAwareStamper to track bucket usage
   */
  /**
   * Build a `UtilizationAwareStamper` with its persisted-state read ordered
   * UNDER the batch's `swarm-write-<batchId>` Web Lock. `create` seeds bucket
   * state from IndexedDB; stamped-but-unflushed buckets exist only during an
   * in-flight write to the SAME batch, and every write holds that batch's lock
   * (nested inside the account lock) across the write and its flush — so the
   * batch lock alone orders the seed read after any such flush. Deliberately
   * NOT the account lock: that one is held for the full duration of writes to
   * UNRELATED batches, so building here would park a node rebind or a
   * default-stamp change behind a minutes-long upload to some other drive.
   *
   * Concurrent requests for the same build share one in-flight promise. The
   * serialized work queue used to provide that by construction; now that
   * builds also run off it, two callers could otherwise race to create two
   * live stampers for one batch — each with its own bucket state — which is
   * exactly the divergence the lock exists to prevent. The key includes the
   * ACCOUNT inputs baked into the built instance (owner + encryption key), so
   * a build in flight across a local→synced migration — same batch, same
   * signer, different account inputs — is never shared with the
   * post-migration caller.
   *
   * WAITS: only for an in-flight write to the SAME batch, which is required
   * for correctness. Deadlock-free: writers acquire account → batch in one
   * fixed order; this acquires a single batch lock and never the account lock.
   */
  private createStamperUnderBatchLock(
    accountInfo: {
      accountId: string
      owner: EthAddress
      encryptionKey: Uint8Array
    },
    signerKey: string,
    batchId: BatchId,
    depth: number,
    store: UtilizationStoreDB,
  ): Promise<UtilizationAwareStamper> {
    const key = [
      batchId.toHex(),
      signerKey,
      accountInfo.owner.toHex(),
      uint8ArrayToHex(accountInfo.encryptionKey),
    ].join(":")
    const inFlight = this.stamperBuilds.get(key)
    if (inFlight) return inFlight
    const build = withBatchStateLock(batchId.toHex(), () =>
      UtilizationAwareStamper.create(
        signerKey,
        batchId,
        depth,
        store,
        accountInfo.owner,
        accountInfo.encryptionKey,
      ),
    ).finally(() => this.stamperBuilds.delete(key))
    this.stamperBuilds.set(key, build)
    return build
  }

  private async initializeStamper(stampDepth: number): Promise<void> {
    // Any bail-out below leaves NO coordinator behind, not just the
    // create-failure catch: `bindStamp` already switched postageBatchId/
    // signerKey and cleared the stamper, so a surviving coordinator would
    // belong to the PREVIOUS batch — heartbeating lease SOCs under a batch
    // this proxy no longer serves, and stranding `resolveUploadStamper`'s
    // promotion path, which is gated on `!this.coordinator`.
    const bailOut = (): void => {
      this.coordinator?.teardown()
      this.coordinator = undefined
    }
    if (!this.signerKey || !this.postageBatchId) {
      console.warn(
        "[Proxy] Cannot initialize stamper: missing signer key or batch ID",
      )
      bailOut()
      return
    }

    // Look up account info for utilization tracking
    const accountInfo = await this.lookupAccountForApp()
    if (!accountInfo) {
      console.warn("[Proxy] Cannot initialize stamper: account not found")
      bailOut()
      return
    }

    // Initialize utilization cache if not already done
    if (!this.utilizationStore) {
      this.utilizationStore = new UtilizationStoreDB()
    }

    // Create utilization-aware stamper with owner and encryption key
    try {
      // Reuse the cached instance for this batch when one exists. A stamper
      // captures no node URL (only the coordinator does), so a re-init driven
      // by a Bee-node change has nothing to rebuild — and rebuilding is not
      // free: it waits on the account write lock, which a long upload holds for
      // its whole duration, and `setStampEntry` would terminate the batch's
      // worker pool for nothing. Any surviving entry is same-account by
      // invariant: an account-fingerprint change clears the whole cache
      // (`refreshStampFromStorage`), as do the auth transitions.
      const cached = this.stampEntries.get(this.postageBatchId)
      this.stamper =
        cached && cached.signerKey === this.signerKey
          ? cached.stamper
          : await this.createStamperUnderBatchLock(
              accountInfo,
              this.signerKey,
              new BatchId(this.postageBatchId),
              stampDepth,
              this.utilizationStore,
            )
      this.stamperAccountFingerprint = `${accountInfo.owner.toHex()}-${uint8ArrayToHex(accountInfo.encryptionKey)}`
      // The default binding's stamper is also the cache entry for its batch —
      // one instance per batch, shared by targeted and untargeted writes.
      this.setStampEntry(this.stamper, this.signerKey)
    } catch (error) {
      console.error("[Proxy] Failed to create stamper:", error)
      this.stamper = undefined
      this.stamperAccountFingerprint = undefined
      bailOut()
      return
    }

    // Build the write-path coordinator for this account. It owns the
    // cross-tab (account-scoped) write lock, the partition-lease lifecycle,
    // and the stamp flush; the default binding's stamper is its lease stamper
    // and targeted batches join its lease per write. Lock-SOC routing on the
    // stamper was auto-bound inside `UtilizationAwareStamper.create`. For
    // multi-device accounts the coordinator eagerly pre-acquires a partition
    // in the background (`startLease`) so the first upload doesn't pay the
    // acquire latency; a concurrent first upload queues on the same write
    // lock and then finds the lease already held. Single-device accounts get
    // a lock-only coordinator.
    this.coordinator?.teardown()
    const backupKeyHex = await deriveSecret(
      uint8ArrayToHex(accountInfo.encryptionKey),
      "backup-key",
    )
    const tuning = readPartitionTuningOverride()
    this.coordinator = new BatchWriteCoordinator({
      // Never `this.bee`: in subsidised mode that points at the gateway, and
      // stamped writes + lease SOCs must always target the configured node.
      bee: new Bee(this.beeApiUrl),
      leaseStamper: this.stamper,
      deviceId: this.requireDeviceId(),
      knownDeviceIds: () =>
        this.knownDeviceIdsForAccount(accountInfo.accountId),
      // Pull the latest device registry before a fresh acquire so a peer that
      // signed in after we created the account is known (else we never read its
      // beacon and dual-acquire). Throttled + best-effort inside.
      refreshKnownDeviceIds: () =>
        this.refreshDeviceRegistryFromSwarm(
          accountInfo.accountId,
          accountInfo.encryptionKey,
        ),
      intentReadTimeoutMs: tuning?.readTimeoutMs,
      intentGuardWindowMs: tuning?.guardWindowMs,
      intentGuardPollMs: tuning?.guardPollMs,
      accountId: accountInfo.accountId,
      backupSigner: new PrivateKey(backupKeyHex),
      swarmEncryptionKey: accountInfo.encryptionKey,
      partitionCount: accountInfo.partitionCount,
      mode: "persistent",
      readLeaseCache: () => this.readLeaseCache(accountInfo.accountId),
      writeLeaseCache: (snap) =>
        this.writeLeaseCache(accountInfo.accountId, snap ?? null),
      // Unconditional: this only fires from the coordinator's `lockAndFlush`,
      // i.e. a stamped write whose stamper really did stamp. It used to be
      // gated on `!isSubsidisedModeActive()`, which is ALSO true whenever the
      // default binding is cleared while a gateway is configured — and a
      // targeted write still takes the stamped path there — so the flush was
      // skipped while `publishState` → `setSyncedReference` kept persisting,
      // leaving the next session with a local counter BELOW its synced
      // reference (the one direction `claimPartition`'s SAFETY INVARIANT rules
      // out, and one `writePartitionState`'s tripwire cannot catch).
      flushStamperState: (stamper) => this.saveStamperState(stamper),
      getWorkerPool: (stamper, count) =>
        this.getOrCreateWorkerPool(stamper, count),
      resolveStamperForBatch: (batchIdHex) =>
        this.resolveStamperForBatch(batchIdHex),
      onLeaseChange: () => this.emitConnectionInfoIfChanged(),
      // On first acquiring a partition, announce this device by publishing the
      // account snapshot (which includes ourselves in metadata.devices) to the
      // shared feed. Debounced + deferred so it runs OUTSIDE the acquiring write
      // lock (the publish re-enters the lock via the coordinator).
      onLeaseAcquired: () => this.schedulePublish("acquired"),
    })
    this.coordinator.startLease()
  }

  /**
   * This device's identity, captured once. Lazily initialised here as a
   * fallback; the auth entry points set it eagerly. Reused for every lease
   * operation so acquire / refresh / validate never disagree about who we
   * are (which previously caused false "reclaimed by another device").
   */
  private requireDeviceId(): string {
    if (!this.deviceId) this.deviceId = getOrCreateDeviceId()
    return this.deviceId
  }

  private readLeaseCache(
    accountId: string,
  ): PartitionLeaseStateSnapshot | undefined {
    try {
      const raw = localStorage.getItem(leaseCacheStorageKey(accountId))
      return raw ? (JSON.parse(raw) as PartitionLeaseStateSnapshot) : undefined
    } catch {
      return undefined
    }
  }

  private writeLeaseCache(
    accountId: string,
    snap: PartitionLeaseStateSnapshot | null,
  ): void {
    const key = leaseCacheStorageKey(accountId)
    if (snap === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(snap))
    }
  }

  /**
   * Record `stamper` as the cached instance for its batch. A replaced instance
   * (rebuild after a signer/account change) terminates the old entry's worker
   * pool — the pool captured the old stamper's buckets.
   */
  private setStampEntry(
    stamper: UtilizationAwareStamper,
    signerKey: string,
  ): void {
    const key = stamper.batchId.toHex()
    const existing = this.stampEntries.get(key)
    if (existing && existing.stamper !== stamper) {
      existing.workerPool?.terminate()
    }
    this.stampEntries.set(key, { stamper, signerKey })
  }

  /** Drop every cached stamper + worker pool (account/sign-out transitions). */
  private clearStampEntries(): void {
    for (const entry of this.stampEntries.values()) {
      entry.workerPool?.terminate()
    }
    this.stampEntries.clear()
  }

  /**
   * Evict cached stampers whose batch the account no longer owns (tombstoned
   * or removed) so a stale instance can't serve a later targeted write.
   *
   * No connection means "we can't tell what's owned", which is NOT the same as
   * "nothing is owned" — pruning against an empty set would drop every cached
   * stamper and terminate its worker pool, including, mid-flight, the pool a
   * long worker-backed upload is running on (writes run off the work queue, so
   * a storage event can land during one).
   */
  private pruneStampEntries(): void {
    const connection = this.findConnectionForParent()
    if (!connection) return
    const owned = new Set(
      connection.account.postageStamps
        .filter((s) => !s.deletedAt)
        .map((s) => s.batchID.toHex()),
    )
    for (const [key, entry] of this.stampEntries) {
      if (!owned.has(key)) {
        entry.workerPool?.terminate()
        this.stampEntries.delete(key)
      }
    }
  }

  /**
   * Get or create a StampWorkerPool for parallel signing with the GIVEN
   * stamper. Cached per batch on its stamp entry and reused across uploads —
   * a pool captures a specific stamper's batch/buckets, so it is never shared
   * across batches (or across a rebuilt stamper instance). Recreated when
   * requestedCount differs from the cached pool's size.
   */
  private async getOrCreateWorkerPool(
    stamper: UtilizationAwareStamper,
    requestedCount?: number,
  ): Promise<StampWorkerPool | undefined> {
    const desiredCount =
      requestedCount ??
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? Math.min(navigator.hardwareConcurrency, 8)
        : 4)

    const entry = this.stampEntries.get(stamper.batchId.toHex())
    if (!entry || entry.stamper !== stamper) return undefined

    if (entry.workerPool && entry.workerPool.size === desiredCount) {
      return entry.workerPool
    }

    // Terminate old pool if count changed
    if (entry.workerPool) {
      entry.workerPool.terminate()
      entry.workerPool = undefined
    }

    try {
      entry.workerPool = await StampWorkerPool.create(
        entry.signerKey,
        stamper,
        desiredCount,
      )
      // Cap live pools at two — the default binding's and this write's batch.
      // Each pool holds up to 8 workers and entries are cached for the whole
      // session, so keeping one pool per batch ever targeted would let worker
      // count grow with every drive touched. An evicted batch just re-creates
      // its pool on its next worker-backed write.
      const keep = new Set([stamper.batchId.toHex(), this.postageBatchId])
      for (const [key, other] of this.stampEntries) {
        if (keep.has(key) || !other.workerPool) continue
        other.workerPool.terminate()
        other.workerPool = undefined
      }
      return entry.workerPool
    } catch (error) {
      console.warn("[Proxy] Failed to create StampWorkerPool:", error)
      return undefined
    }
  }

  /**
   * Save the GIVEN stamper's bucket state to IndexedDB and broadcast the
   * delta under ITS batch id — never the default binding's (a targeted
   * write's flush must not masquerade as the default batch's).
   */
  private async saveStamperState(
    stamper: UtilizationAwareStamper,
  ): Promise<void> {
    try {
      // Capture bucket updates BEFORE flush clears dirtyBuckets
      const buckets = stamper.getBucketUpdatesForBroadcast()

      await stamper.flush()

      // Broadcast utilization update to other tabs with pre-captured buckets
      if (buckets.length > 0) {
        this.utilizationChannel.postMessage({
          type: "utilization-updated",
          batchId: stamper.batchId.toHex(),
          buckets,
        })
      }
    } catch (error) {
      console.error("[Proxy] Failed to save stamper state:", error)
    }
  }

  /**
   * Execute an upload operation against the right target for the current mode.
   * In subsidised mode (no usable user stamp) the gateway handles stamping, so
   * there is no local stamp state to protect and we run unlocked. In user-stamp
   * mode the write's stamper is first resolved (`batchID` target from the
   * per-batch cache, else the app's default binding) and the write then goes
   * through the {@link BatchWriteCoordinator} with that stamper as its batch
   * context.
   *
   * Only the RESOLUTION runs on the shared work queue (atomic with
   * storage-event rebinds — the queue can't swap the binding while a write's
   * stamper/coordinator are being picked). The write itself runs OFF the
   * queue: it can take minutes (large upload) or park on the cross-tab
   * account Web Lock, and holding the queue through that would stall sign-out
   * propagation, stamp changes, and node rebinds behind it. A rebind landing
   * mid-write tears down the captured coordinator, whose breaker aborts the
   * in-flight stamp with `PartitionLeaseLostError` — a loud failure, never a
   * write under a swapped binding.
   *
   * A targeted batch never mutates the default binding: the account-scoped
   * coordinator joins it to the held partition lease with no
   * release/re-acquire.
   */
  private async withModeAwareWriteLock<T>(
    targetOptions: { useWorkers?: boolean; workerCount?: number } | undefined,
    operation: (target: UploadTarget) => Promise<T>,
    batchID?: string,
  ): Promise<T> {
    // No stamp binding can be involved — run unlocked and unqueued so
    // subsidised uploads stay concurrent.
    if (!batchID && this.isSubsidisedModeActive()) {
      return operation({
        mode: "subsidised",
        gatewayUrl: this.subsidisedGatewayUrl!,
      })
    }
    let resolved = await this.enqueueWork(async () => {
      const picked = await this.resolveUploadStamper(batchID, {
        deferBuild: true,
      })
      // `coordinator` captured atomically with the stamper: the pair the
      // off-queue write below runs against, immune to later rebinds.
      return { ...picked, coordinator: this.coordinator }
    })
    if (resolved.pendingBuild) {
      // Built OFF the queue: the build waits on the account write lock, which
      // an in-flight write to this account holds for its whole duration, and
      // holding the queue through that would stall sign-out propagation, stamp
      // changes and node rebinds behind an upload. Concurrent writes to the
      // same new batch share one build (`stamperBuilds`).
      const { stamp, signerKey, accountInfo, store } = resolved.pendingBuild
      const stamper = await this.createStamperUnderBatchLock(
        accountInfo,
        signerKey,
        stamp.batchID,
        stamp.depth,
        store,
      ).catch((error: unknown) => {
        console.error("[Proxy] Failed to create target stamper:", error)
        throw new Error(
          `Failed to build stamper for batch ${stamp.batchID.toHex()}`,
        )
      })
      // Back on the queue to install and re-capture atomically. The stamp may
      // have been tombstoned or its signer rotated while we were building, in
      // which case the freshly built stamper must NOT be installed or used.
      resolved = await this.enqueueWork(async () => {
        const still = this.findOwnedStamp(stamp.batchID.toHex())
        if (!still || still.signerKey.toHex() !== signerKey) {
          throw new Error("Batch not owned by account")
        }
        this.setStampEntry(stamper, signerKey)
        return { stamper, coordinator: this.coordinator }
      })
    }
    // Re-resolving the default may have cleared the binding (e.g. the
    // default stamp was deleted) — fall back to the gateway if configured.
    // NEVER for an explicit `batchID`: silently landing a targeted upload
    // on the gateway's batch would betray the requested target — fail it.
    if (!resolved.stamper && !batchID && this.isSubsidisedModeActive()) {
      return operation({
        mode: "subsidised",
        gatewayUrl: this.subsidisedGatewayUrl!,
      })
    }
    if (!resolved.stamper || !resolved.coordinator) {
      throw new Error("Stamper not initialized. Please login first.")
    }
    return resolved.coordinator.withWrite(
      resolved.stamper,
      operation,
      targetOptions,
    )
  }

  /**
   * Setup message listener for parent and popup messages
   */
  private setupMessageListener(): void {
    window.addEventListener("message", async (event: MessageEvent) => {
      const { type } = event.data

      // Handle parent identification (must come first). Only the embedding
      // parent window may identify itself — any co-embedded iframe can obtain
      // our WindowProxy and race the real parent otherwise (#410).
      if (type === "parentIdentify") {
        if (event.source !== window.parent) {
          console.warn("[Proxy] Rejected parentIdentify from non-parent window")
          return
        }
        const result = ParentIdentifyMessageSchema.safeParse(event.data)
        if (!result.success) {
          console.warn("[Proxy] Invalid parentIdentify message:", result.error)
          return
        }
        try {
          await this.handleParentIdentify(result.data, event)
        } catch (error) {
          // Without this the parent never hears back and its initialize()
          // hangs until the initialization timeout.
          console.error("[Proxy] Initialization failed:", error)
          this.postMessage(event, {
            type: "initError",
            error:
              error instanceof Error ? error.message : "Initialization failed",
          })
        }
        return
      }

      // All other messages require parent to be identified first
      if (!this.parentIdentified) {
        console.warn("[Proxy] Ignoring message - parent not identified yet")
        return
      }

      // Handle same-origin popup messages (storage partitioning postMessage fallback)
      if (event.origin === window.location.origin && type === "setSecret") {
        const popupResult = PopupToIframeMessageSchema.safeParse(event.data)
        if (popupResult.success) {
          await this.handlePopupMessage(popupResult.data)
          return
        }
      }

      // Validate origin - only accept messages from parent
      if (event.origin !== this.parentOrigin) {
        console.warn(
          "[Proxy] Rejected message from unauthorized origin:",
          event.origin,
        )
        return
      }

      let message: ParentToIframeMessage
      try {
        message = ParentToIframeMessageSchema.parse(event.data)
      } catch (error) {
        console.warn("[Proxy] Invalid parent message:", error)
        return
      }

      try {
        await this.handleParentMessage(message, event)
      } catch (error) {
        console.error("[Proxy] Error handling parent message:", error)
        this.sendErrorToParent(
          event,
          message.requestId,
          error instanceof Error ? error.message : "Unknown error",
        )
      }
    })
  }

  /**
   * Handle parent identification
   */
  private async handleParentIdentify(
    message: ParentIdentifyMessage,
    event: MessageEvent,
  ): Promise<void> {
    // Prevent parent from changing after first identification
    if (this.parentIdentified) {
      console.error("[Proxy] Parent already identified! Ignoring duplicate.")
      return
    }

    const parentPopupMode = message.popupMode
    const parentMetadata = message.metadata
    const parentButtonConfig = message.buttonConfig

    // Trust event.origin - this is browser-enforced and cannot be spoofed
    this.parentOrigin = event.origin
    this.parentIdentified = true
    // Store reference to parent window for later postMessage calls
    if (event.source) {
      this.parentWindow = event.source as WindowProxy
    }

    // Use parent's popup mode if provided
    if (parentPopupMode) {
      this.popupMode = parentPopupMode
    }

    // Store metadata from parent
    if (parentMetadata) {
      this.appMetadata = parentMetadata
    }

    // Store button config from parent
    if (parentButtonConfig) {
      this.buttonConfig = parentButtonConfig
    }

    // Store subsidised gateway URL from parent
    const parentSubsidisedGatewayUrl = message.subsidisedGatewayUrl
    if (parentSubsidisedGatewayUrl) {
      this.subsidisedGatewayUrl = parentSubsidisedGatewayUrl
    }

    // Override: disable subsidised gateway when using custom Bee API URL
    if (this.beeApiUrl !== DEFAULT_BEE_NODE_URL && this.subsidisedGatewayUrl) {
      this.subsidisedGatewayUrl = undefined
    }

    // Load existing secret if available
    await this.loadAuthData()

    // Update this.bee to use subsidised gateway URL when in subsidised mode
    // This ensures downloads use the same endpoint as uploads
    if (this.isSubsidisedModeActive()) {
      this.bee = new Bee(this.subsidisedGatewayUrl!)
    }

    // Acknowledge receipt
    this.postMessage(event, {
      type: "proxyReady",
      authenticated: this.authenticated,
      parentOrigin: this.parentOrigin,
      supportsBatchTargeting: true,
    })

    // Send the initial ConnectionInfo snapshot. The client awaits this before
    // resolving `initialize()`, so `client.connectionInfo` is populated by then.
    this.emitConnectionInfoIfChanged()
  }

  /**
   * Handle messages from parent window
   */
  private async handleParentMessage(
    message: ParentToIframeMessage,
    event: MessageEvent,
  ): Promise<void> {
    switch (message.type) {
      case "parentIdentify":
        // Already handled above
        break

      case "checkAuth":
        this.handleCheckAuth(message, event)
        break

      case "disconnect":
        this.handleDisconnect(message, event)
        break

      case "uploadData":
        await this.handleUploadData(message, event)
        break

      case "downloadData":
        await this.handleDownloadData(message, event)
        break

      case "deriveAppSecret":
        await this.handleDeriveAppSecret(message, event)
        break

      case "uploadFile":
        await this.handleUploadFile(message, event)
        break

      case "downloadFile":
        await this.handleDownloadFile(message, event)
        break

      case "uploadChunk":
        await this.handleUploadChunk(message, event)
        break

      case "downloadChunk":
        await this.handleDownloadChunk(message, event)
        break

      case "isConnected":
        await this.handleIsConnected(message, event)
        break

      case "getNodeInfo":
        await this.handleGetNodeInfo(message, event)
        break

      case "gsocMine":
        this.handleGsocMine(message, event)
        break

      case "gsocSend":
        await this.handleGsocSend(message, event)
        break
      case "socUpload":
        await this.handleSocUpload(message, event)
        break
      case "socRawUpload":
        await this.handleSocRawUpload(message, event)
        break
      case "socDownload":
        await this.handleSocDownload(message, event)
        break
      case "socRawDownload":
        await this.handleSocRawDownload(message, event)
        break
      case "socGetOwner":
        await this.handleSocGetOwner(message, event)
        break
      case "epochFeedDownloadReference":
        await this.handleEpochFeedDownloadReference(message, event)
        break
      case "epochFeedUploadReference":
        await this.handleEpochFeedUploadReference(message, event)
        break
      case "feedGetOwner":
        await this.handleFeedGetOwner(message, event)
        break
      case "seqFeedGetOwner":
        await this.handleSequentialFeedGetOwner(message, event)
        break
      case "seqFeedDownloadPayload":
        await this.handleSequentialFeedDownloadPayload(message, event)
        break
      case "seqFeedDownloadRawPayload":
        await this.handleSequentialFeedDownloadRawPayload(message, event)
        break
      case "seqFeedDownloadReference":
        await this.handleSequentialFeedDownloadReference(message, event)
        break
      case "seqFeedUploadPayload":
        await this.handleSequentialFeedUploadPayload(message, event)
        break
      case "seqFeedUploadRawPayload":
        await this.handleSequentialFeedUploadRawPayload(message, event)
        break
      case "seqFeedUploadReference":
        await this.handleSequentialFeedUploadReference(message, event)
        break

      case "actUploadData":
        await this.handleActUploadData(message, event)
        break

      case "actDownloadData":
        await this.handleActDownloadData(message, event)
        break

      case "actAddGrantees":
        await this.handleActAddGrantees(message, event)
        break

      case "actRevokeGrantees":
        await this.handleActRevokeGrantees(message, event)
        break

      case "actGetGrantees":
        await this.handleActGetGrantees(message, event)
        break

      case "getPostageBatches":
        await this.handleGetPostageBatches(message, event)
        break

      case "getPostageBatch":
        await this.handleLegacyGetPostageBatch(message, event)
        break

      case "createFeedManifest":
        await this.handleCreateFeedManifest(message, event)
        break

      case "connect":
        this.handleConnect(message, event)
        break

      default:
        // TypeScript should ensure this is never reached
        const exhaustiveCheck: never = message
        console.warn("[Proxy] Unhandled message type:", exhaustiveCheck)
    }
  }

  /**
   * Load authentication data from shared storage (ConnectedApp records).
   */
  private async loadAuthData(): Promise<void> {
    if (!this.parentOrigin) {
      this.authLoading = false
      return
    }

    const sharedData = this.lookupAppSecretFromSharedStorage()

    if (sharedData) {
      this.appSecret = sharedData.secret
      this.authenticated = true
      this.authLoading = false
      this.showAuthButton()

      // Look up postage stamp from shared storage based on connected identity
      const stamp = this.lookupPostageStampForApp()
      if (stamp) {
        await this.bindStamp(stamp)
      } else {
        this.clearDefaultBinding()
      }
    } else {
      this.authLoading = false
      this.showAuthButton()
    }
  }

  /**
   * Look up the postage stamp for the currently connected app's identity
   * by reading from shared localStorage stores.
   */
  private lookupPostageStampForApp(): PostageStamp | undefined {
    if (!this.parentOrigin) {
      return undefined
    }

    try {
      const connection = this.findConnectionForParent()
      if (!connection) {
        return undefined
      }
      const { account, app } = connection

      // Resolve the stamp this app should use: its per-app override if set,
      // otherwise the account default — skipping a pointer whose stamp is
      // missing so a stale pointer falls through instead of failing.
      return resolveStampForApp(app, account, account.postageStamps)
    } catch (error) {
      console.error("[Proxy] Error looking up postage stamp:", error)
      return undefined
    }
  }

  /**
   * Bind the proxy's active batch/signer to a stamp and (re)build its stamper +
   * write coordinator. Lenient like `initializeStamper`: on failure the stamper
   * ends up `undefined` (auth paths tolerate that and fall back to subsidised
   * mode); callers that must not proceed without a stamper check it afterwards.
   */
  private async bindStamp(stamp: PostageStamp): Promise<void> {
    this.postageBatchId = stamp.batchID.toHex()
    this.signerKey = stamp.signerKey.toHex()
    // Clear first so a swallowed `initializeStamper` failure can't leave the
    // previous batch's stamper paired with the new batch id.
    this.stamper = undefined
    this.stamperAccountFingerprint = undefined
    await this.initializeStamper(stamp.depth)
  }

  /**
   * A non-tombstoned stamp the connected account owns, by hex batch id.
   */
  private findOwnedStamp(batchIdHex: string): PostageStamp | undefined {
    const connection = this.findConnectionForParent()
    return connection?.account.postageStamps.find(
      (s) => !s.deletedAt && s.batchID.toHex() === batchIdHex,
    )
  }

  /**
   * Re-run stamper/coordinator construction for the currently bound stamp so
   * they capture the current Bee node URL. No-op when no stamp is bound or the
   * bound stamp is no longer in storage.
   */
  private async rebindActiveStamp(): Promise<void> {
    if (!this.postageBatchId) {
      return
    }
    const stamp = this.findOwnedStamp(this.postageBatchId)
    if (!stamp) {
      return
    }
    await this.bindStamp(stamp)
  }

  /**
   * Resolve the stamper an upload writes with. With no `batchID` the default
   * binding is re-resolved from storage (so a stale binding can't outlive a
   * default-stamp change) and its stamper returned (undefined → the caller
   * falls back to subsidised mode or fails). With a `batchID`, the named stamp
   * — which must be one the account owns — is served from the per-batch cache
   * or built on first use; the default binding is NEVER mutated by a targeted
   * write. Exception: when no default resolves at all (no coordinator), a
   * targeted owned stamp is promoted to the default binding so uploads work
   * on accounts whose default pointer is gone.
   *
   * Must run on the shared work queue (`withModeAwareWriteLock` does) so a
   * storage-event rebind can't swap the binding while a write's stamper and
   * coordinator are being picked. (The write itself then runs off the queue —
   * see `withModeAwareWriteLock`.)
   *
   * With `deferBuild`, a target that needs a NEW stamper is returned as a
   * `pendingBuild` descriptor instead of being built here: the build waits on
   * the account write lock, and the caller must not hold the work queue across
   * that wait. The caller builds it off-queue and re-enters the queue to
   * install it.
   */
  private async resolveUploadStamper(
    batchID?: string,
    opts?: { deferBuild?: boolean },
  ): Promise<{
    stamper?: UtilizationAwareStamper
    pendingBuild?: {
      stamp: PostageStamp
      signerKey: string
      accountInfo: {
        accountId: string
        owner: EthAddress
        encryptionKey: Uint8Array
      }
      store: UtilizationStoreDB
    }
  }> {
    if (!batchID) {
      await this.refreshStampFromStorage()
      return { stamper: this.stamper }
    }
    const targetHex = batchID.toLowerCase()
    if (targetHex === this.postageBatchId && this.stamper) {
      return { stamper: this.stamper }
    }
    // NB: when the target IS the bound default batch but its stamper failed to
    // build (lenient `initializeStamper`), fall through — the targeted build
    // path below constructs a working stamper for it without touching the
    // (broken) default binding, instead of returning `undefined` and letting
    // the caller misroute an explicitly targeted upload.
    const stamp = this.findOwnedStamp(targetHex)
    if (!stamp) {
      const stale = this.stampEntries.get(targetHex)
      if (stale) {
        stale.workerPool?.terminate()
        this.stampEntries.delete(targetHex)
      }
      throw new Error("Batch not owned by account")
    }
    if (!this.coordinator) {
      // Cold start with no default at all: promote this stamp to the binding.
      // There is no in-flight write to block on here, so the build stays inline.
      await this.bindStamp(stamp)
      if (!this.stamper) {
        throw new Error(`Failed to bind stamp ${targetHex}`)
      }
      return { stamper: this.stamper }
    }
    const signerKey = stamp.signerKey.toHex()
    const cached = this.stampEntries.get(targetHex)
    if (cached && cached.signerKey === signerKey) {
      return { stamper: cached.stamper }
    }
    const accountInfo = await this.lookupAccountForApp()
    if (!accountInfo || !this.utilizationStore) {
      throw new Error(`Failed to build stamper for batch ${targetHex}`)
    }
    const pendingBuild = {
      stamp,
      signerKey,
      accountInfo,
      store: this.utilizationStore,
    }
    if (opts?.deferBuild) return { pendingBuild }
    try {
      const stamper = await this.createStamperUnderBatchLock(
        accountInfo,
        signerKey,
        stamp.batchID,
        stamp.depth,
        this.utilizationStore,
      )
      this.setStampEntry(stamper, signerKey)
      return { stamper }
    } catch (error) {
      console.error("[Proxy] Failed to create target stamper:", error)
      throw new Error(`Failed to build stamper for batch ${targetHex}`)
    }
  }

  /**
   * Resolve an owned batch's stamper for the coordinator's re-adopt restore:
   * the cached instance, or a freshly built one. Unlike `resolveUploadStamper`
   * this NEVER throws and never promotes anything to the default binding — a
   * batch the account no longer owns, or one whose stamper cannot be built,
   * simply isn't restored (that batch keeps today's behaviour).
   */
  private async resolveStamperForBatch(
    batchIdHex: string,
  ): Promise<UtilizationAwareStamper | undefined> {
    const stamp = this.findOwnedStamp(batchIdHex)
    if (!stamp) return undefined
    const signerKey = stamp.signerKey.toHex()
    const cached = this.stampEntries.get(batchIdHex)
    if (cached && cached.signerKey === signerKey) return cached.stamper
    const accountInfo = await this.lookupAccountForApp()
    if (!accountInfo || !this.utilizationStore) return undefined
    try {
      const stamper = await this.createStamperUnderBatchLock(
        accountInfo,
        signerKey,
        stamp.batchID,
        stamp.depth,
        this.utilizationStore,
      )
      this.setStampEntry(stamper, signerKey)
      return stamper
    } catch (error) {
      console.warn(
        `[Proxy] Could not build stamper for joined batch ${batchIdHex}:`,
        error,
      )
      return undefined
    }
  }

  /**
   * Look up the account for the currently connected app's identity
   * by reading from shared localStorage stores.
   *
   * @returns Account info with owner address and encryption key, or undefined if not found
   */
  private async lookupAccountForApp(): Promise<
    | {
        owner: EthAddress
        encryptionKey: Uint8Array
        accountId: string
        partitionCount: number
      }
    | undefined
  > {
    if (!this.parentOrigin) {
      return undefined
    }

    try {
      const connection = this.findConnectionForParent()
      if (!connection) {
        return undefined
      }
      const { account } = connection

      // Derive swarm encryption key from stored derivation key
      const swarmEncryptionKey = await deriveSwarmEncryptionKey(
        account.derivationKey,
      )

      return {
        owner: account.id,
        encryptionKey: hexToUint8Array(swarmEncryptionKey),
        accountId: account.id.toHex(),
        partitionCount: account.partitionCount ?? 1,
      }
    } catch (error) {
      console.error("[Proxy] Error looking up account:", error)
      return undefined
    }
  }

  /**
   * Current device IDs registered for `accountId`, read fresh from shared
   * storage so the partition-intent round (Phase 2) reflects devices that
   * announced after the coordinator was built. Returns [] on any error — the
   * lease then falls back to the guard+TTL acquire path.
   */
  private knownDeviceIdsForAccount(accountId: string): string[] {
    try {
      const accounts = createAccountsStorageManager().load()
      const account = accounts.find((a) => a.id.toHex() === accountId)
      if (!account || isSignedOutAccount(account)) return []
      // Bound the partition rival set to recently-active devices: removed
      // (tombstoned) devices won't write, and long-dead ghosts from old sessions
      // (the device list is append-only) would each add an absent intent read to
      // every acquire — on a flaky gateway that can push a single acquire past
      // its timeout, so a live device can't claim even a FREE partition. A
      // genuinely-live holder is still caught by the deviceId-independent
      // occupancy beacon, so pruning here only removes dead-device cost.
      return activeDeviceIds(
        account.devices,
        Date.now(),
        KNOWN_DEVICE_MAX_AGE_MS,
      )
    } catch {
      return []
    }
  }

  private lastDeviceRegistryRefreshAt = 0

  /**
   * Pull the latest account snapshot from the shared feed and union its
   * `metadata.devices` into the locally-stored account, so `knownDeviceIds`
   * reflects a peer that signed in AFTER this device created the account (else
   * the claimer never reads the peer's beacon and they dual-acquire). Throttled
   * (the slot-wait loop re-acquires) and best-effort — on any failure the
   * current registry is used as-is.
   */
  private async refreshDeviceRegistryFromSwarm(
    accountId: string,
    encryptionKey: Uint8Array,
  ): Promise<void> {
    const nowMs = Date.now()
    if (
      nowMs - this.lastDeviceRegistryRefreshAt <
      DEVICE_REGISTRY_REFRESH_THROTTLE_MS
    ) {
      return
    }
    this.lastDeviceRegistryRefreshAt = nowMs
    try {
      const manager = createAccountsStorageManager()
      const accounts = manager.load()
      const account = accounts.find((a) => a.id.toHex() === accountId)
      if (!account || isSignedOutAccount(account)) return

      // Feed owner = backup signer (derived from the swarm encryption key).
      // Phase 3a: discovery is the append-only device roster, not a shared doc.
      const backupKey = new PrivateKey(
        await deriveSecret(uint8ArrayToHex(encryptionKey), "backup-key"),
      )
      const owner = backupKey.publicKey().address()
      const rosterDevices = await readRoster({
        bee: this.bee,
        accountId: account.id.toHex(),
        owner,
      })
      if (rosterDevices.length === 0) return

      const mergedDevices = mergeDevices(
        mergeDevicesList(account.devices, rosterDevices),
        this.requireDeviceId(),
        detectDeviceName(),
      )
      // Only persist when a peer actually appeared, to avoid needless cross-tab
      // storage-event churn.
      if (mergedDevices.length !== account.devices.length) {
        manager.save(
          accounts.map((a) =>
            a.id.toHex() === accountId ? { ...a, devices: mergedDevices } : a,
          ),
        )
      }
    } catch (error) {
      console.warn(
        "[Proxy] Device-registry refresh failed (using current registry):",
        error,
      )
    }
  }

  /**
   * Assemble the current account-state snapshot for the connected app's account
   * from shared localStorage (the same shape `sync-account` builds from its DI
   * stores). Returns the snapshot plus the feed signing key + owner. Undefined
   * when storage is partitioned or the account/stamp can't be resolved.
   */
  private async buildAccountStateSnapshotForPublish(): Promise<
    | {
        snapshot: AccountStateSnapshot
        encryptionKey: string
        accountKey: PrivateKey
        owner: EthAddress
      }
    | undefined
  > {
    if (!this.parentOrigin || this.storagePartitioned) {
      return undefined
    }
    try {
      const connection = this.findConnectionForParent()
      if (!connection) return undefined
      const { account } = connection

      const defaultStampBatchID = account.defaultPostageStampBatchID
      if (!defaultStampBatchID) return undefined

      const encryptionKey = await deriveSwarmEncryptionKey(
        account.derivationKey,
      )
      const accountKey = new PrivateKey(
        await deriveSecret(encryptionKey, "backup-key"),
      )
      const owner = accountKey.publicKey().address()

      const snapshot: AccountStateSnapshot = {
        version: 1,
        timestamp: Date.now(),
        accountId: account.id.toHex(),
        metadata: {
          accountName: account.name,
          defaultPostageStampBatchID: defaultStampBatchID.toHex(),
          publicKey: account.publicKey,
          settings: account.settings,
          // Unedited scalar → STABLE createdAt, never the fresh lastModified: a
          // device editing a *different* field must not restamp an unchanged
          // scalar and clobber a peer's concurrent edit under per-field LWW (§9.3).
          accountNameAt: account.accountNameAt ?? account.createdAt,
          defaultStampAt: account.defaultStampAt ?? account.createdAt,
          settingsAt: account.settingsAt ?? account.createdAt,
          createdAt: account.createdAt,
          lastModified: Date.now(),
          devices: account.devices,
          partitionCount: account.partitionCount ?? 1,
        },
        connectedApps: account.connectedApps,
        postageStamps: account.postageStamps,
      }
      return { snapshot, encryptionKey, accountKey, owner }
    } catch (error) {
      console.error("[Proxy] Failed to assemble account-state snapshot:", error)
      return undefined
    }
  }

  /**
   * Schedule a debounced account-state publish. Safe to call from inside the
   * coordinator's lease callbacks: it only arms a timer, so the actual publish
   * runs later, outside any held write lock.
   */
  private schedulePublish(reason: "acquired" | "change"): void {
    if (!this.coordinator) return
    // "change" dominates: if a real delta is pending in this debounce window,
    // don't let a coalesced "acquired" downgrade it to the announce-gated path.
    if (this.publishReason !== "change") this.publishReason = reason
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer)
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      const effectiveReason = this.publishReason ?? "acquired"
      this.publishReason = undefined
      void this.runAccountStatePublish(effectiveReason)
    }, PUBLISH_DEBOUNCE_MS)
  }

  /**
   * Publish the account snapshot to the shared feed via the coordinator (same
   * write lock + held partition). Only publishes while a partition is held
   * (multi-device); single-device accounts are published by the SwarmID UI.
   * Re-arms if a publish is already in flight so the latest state still lands.
   */
  private async runAccountStatePublish(
    reason: "acquired" | "change",
  ): Promise<void> {
    const coordinator = this.coordinator
    if (!coordinator || coordinator.currentPartition === undefined) return
    if (this.publishInFlight) {
      this.schedulePublish(reason)
      return
    }
    this.publishInFlight = true
    try {
      const assembled = await this.buildAccountStateSnapshotForPublish()
      if (!assembled) return
      // Snapshot assembly awaits (crypto + storage reads); a disconnect /
      // sign-out / re-auth may have torn down or replaced the coordinator in
      // the meantime. Bail rather than write through a stale instance. (The
      // coordinator also self-guards against re-acquire when disposed; this
      // just avoids the needless lock round-trip.)
      if (this.coordinator !== coordinator) return
      const { snapshot, encryptionKey, accountKey, owner } = assembled

      // The snapshot is assembled from the most recent connection for this
      // origin; if the connected account changed since the coordinator was
      // built, publishing would pair account B's feed (key derived from the
      // snapshot) with account A's batch and partition lease. Skip — the
      // re-initialised coordinator for the new account publishes its own state.
      if (snapshot.accountId !== coordinator.accountId) {
        console.warn(
          `[Proxy] Account changed during publish scheduling (snapshot ${snapshot.accountId} vs coordinator ${coordinator.accountId}); skipping publish.`,
        )
        return
      }

      // Announce-once: a publish triggered purely by acquiring the lease (e.g.
      // every page reload) has nothing new once this device is already in the
      // roster. Skip it. A "change" publish carries a real delta and always
      // re-writes this device's own state feed (no shared contention).
      const deviceId = this.requireDeviceId()
      if (reason === "acquired") {
        const rosterDevices = await readRoster({
          bee: this.bee,
          accountId: snapshot.accountId,
          owner,
        }).catch(() => [])
        const alreadyAnnounced = rosterDevices.some(
          (d) => d.deviceId === deviceId && !d.removedAt,
        )
        if (alreadyAnnounced) {
          console.info(
            `[Proxy] Device already in roster for ${snapshot.accountId}; skipping announce publish.`,
          )
          return
        }
      }

      const thisDevice = snapshot.metadata.devices.find(
        (d) => d.deviceId === deviceId,
      ) ?? {
        deviceId,
        name: detectDeviceName(),
        createdAt: Date.now(),
        lastSignedInAt: Date.now(),
      }
      // Per-field scalar clocks (incl. the stable-`createdAt` fallback for a
      // never-edited field) are derived by `accountStateToDeviceView`.
      const view = accountStateToDeviceView(snapshot)

      // Account-state publishes stamp under the lease (resolved default)
      // batch — the long-lived binding — regardless of what the last targeted
      // upload wrote.
      await coordinator.withWrite(coordinator.stamperRef, (target) =>
        publishDeviceState({
          bee: this.bee,
          accountId: snapshot.accountId,
          device: thisDevice,
          accountKey,
          owner,
          encryptionKey,
          view,
          target,
        }),
      )
      console.info(
        `[Proxy] Published device state for ${snapshot.accountId} (partition ${coordinator.currentPartition})`,
      )
    } catch (error) {
      console.warn("[Proxy] Account-state publish failed:", error)
    } finally {
      this.publishInFlight = false
    }
  }

  /**
   * Check if a connection is still valid based on connectedUntil timestamp
   */
  private isConnectionValid(connectedApp: ConnectedApp): boolean {
    if (!connectedApp.connectedUntil) return false
    return connectedApp.connectedUntil > Date.now()
  }

  /**
   * Find the account + connected-app pair for the current parent origin, reading
   * the nested account documents. Resolves ambiguity (the same app connected
   * under multiple accounts) by sorting valid entries by `lastConnectedAt`
   * descending and returning the most recent.
   */
  private findConnectionForParent():
    | { account: SignedInAccount; app: ConnectedApp }
    | undefined {
    if (!this.parentOrigin) {
      return undefined
    }
    const accounts = createAccountsStorageManager().load()
    const matches: { account: SignedInAccount; app: ConnectedApp }[] = []
    for (const account of accounts) {
      // A signed-out account keeps no connected apps (and no derivationKey to
      // serve them with) — its record is just the vault remnant.
      if (isSignedOutAccount(account)) continue
      for (const app of account.connectedApps) {
        if (app.appUrl === this.parentOrigin && this.isConnectionValid(app)) {
          matches.push({ account, app })
        }
      }
    }
    return matches.sort(
      (a, b) => b.app.lastConnectedAt - a.app.lastConnectedAt,
    )[0]
  }

  /**
   * Look up the app secret from shared storage for the current parent origin.
   * Returns the secret if a valid connection is found.
   */
  private lookupAppSecretFromSharedStorage(): { secret: string } | undefined {
    if (!this.parentOrigin) {
      return undefined
    }

    try {
      const connection = this.findConnectionForParent()
      if (!connection?.app.appSecret) {
        return undefined
      }

      return { secret: connection.app.appSecret }
    } catch (error) {
      console.error(
        "[Proxy] Error looking up app secret from shared storage:",
        error,
      )
      return undefined
    }
  }

  /**
   * Clear authentication data
   */
  private clearAuthData(): void {
    if (!this.parentOrigin) {
      return
    }

    // Clear stamper state from localStorage — every batch's, not just the
    // default binding's (targeted writes may have persisted under others).
    const stamperKeyPrefix = `swarm-stamper-${this.parentOrigin}-`
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(stamperKeyPrefix)) {
        localStorage.removeItem(key)
      }
    }

    // Invalidate matching connected-app entries in the nested account documents
    // so reconnect doesn't happen on refresh (lastConnectedAt=0, no session).
    try {
      const manager = createAccountsStorageManager()
      const accounts = manager.load()
      let changed = false
      const updated = accounts.map((account) => {
        if (isSignedOutAccount(account)) return account
        const connectedApps = account.connectedApps.map((app) => {
          if (app.appUrl === this.parentOrigin) {
            changed = true
            return { ...app, lastConnectedAt: 0, connectedUntil: undefined }
          }
          return app
        })
        return { ...account, connectedApps }
      })
      if (changed) manager.save(updated)
    } catch (error) {
      console.error(
        "[Proxy] Error invalidating connected app in shared storage:",
        error,
      )
    }

    // Reset auth state
    this.authenticated = false
    this.authLoading = false
    this.appSecret = undefined
    this.deviceId = undefined
    this.coordinator?.teardown()
    this.coordinator = undefined
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer)
      this.publishTimer = undefined
    }
    this.clearDefaultBinding()
    this.clearStampEntries()
    this.storagePartitioned = false
    this.storagePartitionedIdentity = undefined
    this.pendingChallenge = undefined

    this.emitConnectionInfoIfChanged()

    // Show login button
    this.showAuthButton()
  }

  /**
   * Send error message to parent
   */
  private sendErrorToParent(
    event: MessageEvent,
    requestId: string | undefined,
    error: string,
  ): void {
    if (requestId) {
      this.postMessage(event, {
        type: "error",
        requestId,
        error,
      })
    }
  }

  private ensureCanUpload(): void {
    if (!this.authenticated || !this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }
    // Allow uploads if subsidised mode is active (gateway handles stamping)
    if (this.isSubsidisedModeActive()) {
      return
    }
    if (this.storagePartitioned) {
      throw new Error(
        "Uploads are unavailable in download-only mode due to browser storage partitioning.",
      )
    }
    // NB: the multi-device "all partitions held" case is NOT checked here.
    // It's deferred to the coordinator's `withWrite`, which runs a fresh
    // acquisition attempt (with slot-wait) under the write lock and then throws
    // if no partition is held — so a read-only upload waits for a slot to free
    // (turn-taking) instead of failing instantly.
  }

  /**
   * Check if subsidised upload mode is active.
   * Subsidised mode is active when:
   * - User has no postage stamp OR no signer key, OR storage is partitioned
   *   (can't access stamp when partitioned)
   * - AND a subsidised gateway URL is configured
   */
  private isSubsidisedModeActive(): boolean {
    return (
      (!this.postageBatchId || !this.signerKey || this.storagePartitioned) &&
      !!this.subsidisedGatewayUrl
    )
  }

  /**
   * Send message to parent
   */
  private sendToParent(message: IframeToParentMessage): void {
    if (!this.parentOrigin || !this.parentWindow) {
      console.warn(
        "[Proxy] Cannot send message to parent - no parent window reference",
      )
      return
    }

    this.parentWindow.postMessage(message, this.parentOrigin)
  }

  /**
   * Send message to the event source (parent window that sent the request)
   */
  private postMessage(
    event: MessageEvent,
    message: IframeToParentMessage,
  ): void {
    if (!event.source) {
      console.warn("[Proxy] Cannot send message - no event source")
      return
    }
    ;(event.source as WindowProxy).postMessage(message, {
      targetOrigin: event.origin,
    })
  }

  // ============================================================================
  // Message Handlers
  // ============================================================================

  private handleCheckAuth(
    message: { type: "checkAuth"; requestId: string },
    event: MessageEvent,
  ): void {
    this.postMessage(event, {
      type: "authStatusResponse",
      requestId: message.requestId,
      authenticated: this.authenticated,
      origin: this.authenticated ? this.parentOrigin : undefined,
      beeApiUrl: this.beeApiUrl,
    })
  }

  /**
   * Build the current ConnectionInfo snapshot from in-memory auth state and
   * shared localStorage. Pure — does not send anything.
   */
  private buildConnectionInfo(): ConnectionInfo {
    let identity: ConnectionInfo["identity"] = undefined

    if (this.authenticated && this.parentOrigin) {
      if (this.storagePartitioned && this.storagePartitionedIdentity) {
        identity = this.storagePartitionedIdentity
      } else {
        try {
          const connection = this.findConnectionForParent()
          if (connection) {
            // The account IS the app-facing identity (single-level model).
            const { account } = connection
            identity = {
              id: account.id.toHex(),
              name: account.name,
              address: account.id.toHex(),
              publicKey: account.publicKey,
              avatar: generatedAvatar(account.id.toHex()),
            }
          }
        } catch (error) {
          console.error("[Proxy] Error looking up identity:", error)
        }
      }
    }

    let appKey: ConnectionInfo["appKey"] = undefined
    if (this.authenticated && this.appSecret) {
      const privKeyBytes = hexToUint8Array(this.appSecret)
      const { x, y } = publicKeyFromPrivate(privKeyBytes)
      const compressed = compressPublicKey(x, y)
      appKey = {
        address: new PrivateKey(this.appSecret).publicKey().address().toHex(),
        publicKey: uint8ArrayToHex(compressed),
      }
    }

    // Upload mode is only meaningful when authenticated — `ensureCanUpload`
    // throws on missing auth, so reporting `canUpload=true` here without an
    // app secret would mislead the dApp into attempting uploads that always
    // fail.
    // - User-stamp mode also requires a fully constructed `stamper`;
    //   `initializeStamper` can swallow errors and leave it `undefined`,
    //   in which case uploads via user stamp will fail.
    // - Subsidised mode is the fallback when no user stamp is usable.
    let uploadMode: "user-stamp" | "subsidised" | "unavailable" = "unavailable"
    if (this.authenticated && this.appSecret) {
      if (
        this.postageBatchId &&
        this.signerKey &&
        this.stamper &&
        !this.storagePartitioned
      ) {
        uploadMode = "user-stamp"
      } else if (this.subsidisedGatewayUrl) {
        uploadMode = "subsidised"
      }
    }

    return {
      canUpload: uploadMode !== "unavailable",
      storagePartitioned: this.storagePartitioned || undefined,
      uploadMode,
      identity,
      appKey,
      partition: this.coordinator?.currentPartition,
    }
  }

  /**
   * Recompute ConnectionInfo and send `connectionInfoChanged` to the parent
   * if it actually differs from the last value we sent. Used both on auth
   * transitions and on storage events that affect derived fields.
   */
  private emitConnectionInfoIfChanged(): void {
    if (!this.parentOrigin) {
      return
    }
    const info = this.buildConnectionInfo()
    if (connectionInfoEqual(this.lastConnectionInfo, info)) {
      return
    }
    this.lastConnectionInfo = info
    this.sendToParent({
      type: "connectionInfoChanged",
      canUpload: info.canUpload,
      storagePartitioned: info.storagePartitioned,
      uploadMode: info.uploadMode,
      identity: info.identity,
      appKey: info.appKey,
      partition: info.partition,
    })
  }

  private async handleIsConnected(
    message: IsConnectedMessage,
    event: MessageEvent,
  ): Promise<void> {
    const connected = await this.bee.isConnected()

    this.postMessage(event, {
      type: "isConnectedResponse",
      requestId: message.requestId,
      connected,
    })
  }

  private async handleGetNodeInfo(
    message: GetNodeInfoMessage,
    event: MessageEvent,
  ): Promise<void> {
    try {
      const nodeInfo = await this.bee.getNodeInfo()

      this.postMessage(event, {
        type: "getNodeInfoResponse",
        requestId: message.requestId,
        beeMode: nodeInfo.beeMode,
        chequebookEnabled: nodeInfo.chequebookEnabled,
        swapEnabled: nodeInfo.swapEnabled,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        message.requestId,
        error instanceof Error ? error.message : "Failed to get node info",
      )
    }
  }

  private handleDisconnect(
    message: { type: "disconnect"; requestId: string },
    event: MessageEvent,
  ): void {
    // Clear auth data
    this.clearAuthData()

    // Send response
    this.postMessage(event, {
      type: "disconnectResponse",
      requestId: message.requestId,
      success: true,
    })
  }

  /**
   * Show authentication button in the UI
   */
  private showAuthButton(): void {
    if (!this.authButtonContainer || this.isConnecting) {
      return
    }

    // Clear existing content
    this.authButtonContainer.innerHTML = ""

    // Create button based on authentication status
    const button = document.createElement("button")
    const isAuthenticated = this.authenticated
    const isLoading = this.authLoading

    // Get text from buttonConfig or use defaults
    const config = this.buttonConfig || {}
    const loadingText = config.loadingText || "⏳ Loading..."
    const disconnectText =
      config.disconnectText || "🔓 Disconnect from Swarm ID"
    const connectText = config.connectText || "🔐 Login with Swarm ID"

    if (isLoading) {
      button.textContent = loadingText
      button.disabled = true
    } else if (isAuthenticated) {
      button.textContent = disconnectText
    } else {
      button.textContent = connectText
    }

    // Make button fill container
    button.style.width = "100%"
    button.style.height = "100%"
    button.style.display = "flex"
    button.style.alignItems = "center"
    button.style.justifyContent = "center"

    if (isLoading) {
      button.style.backgroundColor = "#999"
      button.style.cursor = "default"
    } else if (isAuthenticated) {
      // Different color for disconnect button
      button.style.backgroundColor = "#666"
      button.style.cursor = "pointer"
    } else {
      button.style.backgroundColor = config.backgroundColor || "#dd7200"
      button.style.cursor = "pointer"
    }
    button.style.color = config.color || "white"
    button.style.border = "none"
    button.style.borderRadius = config.borderRadius || "0"
    button.style.padding = "0"
    button.style.fontSize = "14px"
    button.style.fontWeight = "600"

    // Click handler
    button.addEventListener("click", () => {
      if (isAuthenticated) {
        // Handle disconnect
        this.handleDisconnectClick()
      } else {
        // Handle login
        this.handleLoginClick(button)
      }
    })

    this.authButtonContainer.appendChild(button)
  }

  private handleConnect(
    message: {
      type: "connect"
      requestId: string
      popupMode?: "popup" | "window"
    },
    event: MessageEvent,
  ): void {
    const success = this.openAuthPopup({
      popupMode: message.popupMode,
    })
    this.postMessage(event, {
      type: "connectResponse",
      requestId: message.requestId,
      success,
    })
  }

  /**
   * Open the authentication popup window.
   * Returns true if popup was opened, false if parent origin is not set.
   */
  private openAuthPopup(options?: { popupMode?: "popup" | "window" }): boolean {
    if (!this.parentOrigin) {
      console.error("[Proxy] Cannot open auth window - parent origin not set")
      return false
    }

    // Build authentication URL using shared utility
    // challenge: used for storage partitioning detection — popup checks if it can read this from localStorage
    const challenge = crypto.randomUUID()
    this.pendingChallenge = challenge
    localStorage.setItem(STORAGE_CHALLENGE_KEY, challenge)

    // Get base path from current location (e.g., /id/pr-140/proxy -> /id/pr-140)
    const basePath = window.location.pathname.replace(/\/proxy$/, "")
    const authUrl = buildAuthUrl(
      window.location.origin + basePath,
      this.parentOrigin,
      this.appMetadata,
      { challenge },
    )

    // Open as popup or full window based on popupMode (per-call override takes precedence)
    const effectivePopupMode = options?.popupMode ?? this.popupMode
    let popup: Window | null = null
    if (effectivePopupMode === "popup") {
      popup = window.open(authUrl, "_blank", "width=500,height=600")
    } else {
      popup = window.open(authUrl, "_blank")
    }

    // Check if popup was blocked (common on mobile Safari)
    if (!popup) {
      console.warn("[Proxy] Popup was blocked or failed to open")
      this.isConnecting = false
      this.showAuthButton()
      return false
    }

    // Monitor popup closure to handle user closing without completing auth
    // Note: We delay the start of monitoring because on Safari, popup.closed can
    // return true immediately for new tabs before they're fully initialized
    const POPUP_MONITOR_START_DELAY_MS = 2000
    const POPUP_CLOSE_CHECK_INTERVAL_MS = 500
    const POPUP_MONITOR_TIMEOUT_MS = 300000 // 5 minutes

    setTimeout(() => {
      const checkPopupClosed = setInterval(() => {
        if (popup?.closed) {
          clearInterval(checkPopupClosed)
          // Only process if we're still in connecting state (auth didn't complete via storage event)
          if (this.isConnecting && !this.authenticated) {
            this.isConnecting = false
            this.showAuthButton()
          }
        }
      }, POPUP_CLOSE_CHECK_INTERVAL_MS)

      // Clear interval to prevent memory leak
      setTimeout(() => {
        clearInterval(checkPopupClosed)
      }, POPUP_MONITOR_TIMEOUT_MS)
    }, POPUP_MONITOR_START_DELAY_MS)

    return true
  }

  /**
   * Handle login button click
   */
  private handleLoginClick(button: HTMLButtonElement): void {
    this.isConnecting = true
    // Disable button and show spinner
    button.disabled = true
    button.innerHTML =
      '<span style="display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite;"></span>'

    // Add spinner animation
    if (!document.getElementById("swarm-id-spinner-style")) {
      const style = document.createElement("style")
      style.id = "swarm-id-spinner-style"
      style.textContent =
        "@keyframes spin { to { transform: rotate(360deg); } }"
      document.head.appendChild(style)
    }

    // Open auth popup
    this.openAuthPopup()
  }

  /**
   * Handle disconnect button click
   */
  private handleDisconnectClick(): void {
    // Clear auth data
    this.clearAuthData()

    // Notify parent about auth status change
    this.sendToParent({
      type: "authStatusResponse",
      requestId: "disconnect",
      authenticated: false,
      origin: undefined,
    })
  }

  /**
   * Set container element for auth button
   */
  setAuthButtonContainer(container: HTMLElement): void {
    this.authButtonContainer = container
    // Show button now that container is available
    // (loadAuthData may have already run and set authenticated status)
    this.showAuthButton()
  }

  private async handleUploadData(
    message: UploadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      data,
      options,
      requestOptions,
      enableProgress,
      useWebSocket,
      useWorkers,
      workerCount,
      concurrency,
    } = message

    try {
      this.ensureCanUpload()

      // Create progress callback if enabled (works in both modes)
      const onProgress = this.createProgressCallback(
        event,
        requestId,
        enableProgress,
      )

      // Execute upload with mode-aware locking
      const uploadResult = await this.withModeAwareWriteLock(
        { useWorkers, workerCount },
        async (target) => {
          const result = await uploadData(target, data, {
            encryptionKey: options?.encrypt ? true : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
            webSocket: useWebSocket ? { concurrency } : undefined,
            httpConcurrency: concurrency,
            onProgress,
            requestOptions,
          })
          return result
        },
        options?.batchID,
      )

      // Send response
      this.postMessage(event, {
        type: "uploadDataResponse",
        requestId,
        reference: uploadResult.reference,
        tagUid: uploadResult.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      )
    }
  }

  private async handleDownloadData(
    message: DownloadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, options, requestOptions } = message

    try {
      // Download data using chunk API only (supports both regular and encrypted references)
      const data = await downloadDataWithChunkAPI(
        this.bee,
        reference,
        options,
        undefined,
        requestOptions,
      )

      this.postMessage(event, {
        type: "downloadDataResponse",
        requestId,
        data: data as Uint8Array,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }

  private async handleUploadFile(
    message: UploadFileMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      data,
      name,
      options,
      requestOptions,
      enableProgress,
      useWebSocket,
      useWorkers,
      workerCount,
      concurrency,
    } = message
    const fileName = name || "index.bin"

    try {
      this.ensureCanUpload()

      // Create progress callback if enabled
      const onProgress = this.createProgressCallback(
        event,
        requestId,
        enableProgress,
      )

      // Create or use provided tag for the entire upload operation
      const uploadTag = options?.tag ?? (await tryCreateTag(this.bee))

      // Execute upload with mode-aware locking
      const manifestResult = await this.withModeAwareWriteLock(
        { useWorkers, workerCount },
        async (target) => {
          // Step 1: Upload file content
          // Encrypted by default (unless encrypt=false) - encryption is client-side
          const shouldEncryptContent = options?.encrypt !== false

          const contentUpload = await uploadData(target, data, {
            encryptionKey: shouldEncryptContent ? true : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: uploadTag,
            webSocket: useWebSocket ? { concurrency } : undefined,
            httpConcurrency: concurrency,
            onProgress,
            requestOptions,
          })

          // Step 2: Build manifest
          const manifest = new MantarayNode()
          const contentReferenceBytes = hexToUint8Array(contentUpload.reference)

          manifest.addFork(fileName, contentReferenceBytes, {
            "Content-Type": "application/octet-stream",
            Filename: fileName,
          })
          manifest.addFork("/", NULL_ADDRESS, {
            "website-index-document": fileName,
          })

          // Step 3: Upload manifest tree
          const result = await saveMantarayTree(
            manifest,
            async (chunkData, isRoot) => {
              await uploadChunk(target, chunkData, {
                pin: options?.pin,
                deferred: options?.deferred,
                tag: uploadTag,
                requestOptions,
              })
              return { tagUid: isRoot ? uploadTag : undefined }
            },
            { encrypt: options?.encryptManifest === true },
          )

          return result
        },
        options?.batchID,
      )

      // Send response
      this.postMessage(event, {
        type: "uploadFileResponse",
        requestId,
        reference: manifestResult.rootReference,
        tagUid: manifestResult.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      )
    }
  }

  private async handleDownloadFile(
    message: DownloadFileMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, path, options, requestOptions } = message

    try {
      // Always load the manifest first - file uploads create manifests
      const manifest = await loadMantarayTreeWithChunkAPI(
        this.bee,
        reference,
        requestOptions,
      )

      let targetPath: string
      if (path) {
        // Use provided path
        targetPath = path
      } else {
        // No path: get index document from manifest metadata
        const { indexDocument } = manifest.getDocsMetadata()
        if (!indexDocument) {
          throw new Error(
            "Manifest does not contain an index document reference",
          )
        }
        targetPath = indexDocument
      }

      // Find the content node at the target path
      const contentNode = manifest.find(targetPath)
      if (!contentNode) {
        throw new Error(`Path not found in manifest: ${targetPath}`)
      }
      if (!contentNode.targetAddress) {
        throw new Error(`Path "${targetPath}" does not have a target address`)
      }

      // Get filename from metadata or use the path
      const name =
        contentNode.metadata?.["Filename"] ||
        targetPath.split("/").pop() ||
        "file"

      // Download actual content from the target address
      const targetRef = uint8ArrayToHex(contentNode.targetAddress)

      const data = await downloadDataWithChunkAPI(
        this.bee,
        targetRef,
        options,
        undefined,
        requestOptions,
      )

      this.postMessage(event, {
        type: "downloadFileResponse",
        requestId,
        name,
        data,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }

  private async handleUploadChunk(
    message: UploadChunkMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, data, options, requestOptions } = message

    try {
      this.ensureCanUpload()

      // Validate chunk size (must be between 1 and 4096 bytes)
      if (data.length < 1 || data.length > 4096) {
        throw new Error(
          `Invalid chunk size: ${data.length} bytes. Chunks must be between 1 and 4096 bytes.`,
        )
      }

      // Create content-addressed chunk from raw payload
      const chunk = makeContentAddressedChunk(data)

      // Execute upload with mode-aware locking
      await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          await uploadChunk(target, chunk.data, {
            pin: options?.pin,
            deferred: options?.deferred ?? false,
            tag: options?.tag,
            requestOptions,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "uploadChunkResponse",
        requestId,
        reference: chunk.address.toHex(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Upload failed",
      )
    }
  }

  private async handleDownloadChunk(
    message: DownloadChunkMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, reference, options, requestOptions } = message

    try {
      // Download chunk using bee-js (returns Uint8Array directly)
      const data = await this.bee.downloadChunk(
        reference,
        options,
        requestOptions,
      )

      this.postMessage(event, {
        type: "downloadChunkResponse",
        requestId,
        data: data as Uint8Array,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Download failed",
      )
    }
  }

  private handleGsocMine(message: GsocMineMessage, event: MessageEvent): void {
    const { requestId, targetOverlay, identifier, proximity } = message

    try {
      const signer = this.bee.gsocMine(targetOverlay, identifier, proximity)

      this.postMessage(event, {
        type: "gsocMineResponse",
        requestId,
        signer: signer.toHex(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "GSOC mine failed",
      )
    }
  }

  private async handleGsocSend(
    message: GsocSendMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, signer, identifier, data, options } = message

    try {
      this.ensureCanUpload()

      const signerKey = new PrivateKey(signer)
      const id = new Identifier(identifier)

      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await uploadSOC(target, signerKey, id, data, {
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "gsocSendResponse",
        requestId,
        reference: uint8ArrayToHex(result.socAddress),
        tagUid: result.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "GSOC send failed",
      )
    }
  }

  // ============================================================================
  // SOC (Single Owner Chunk) Handlers
  // ============================================================================

  private async handleSocUpload(
    message: SocUploadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, identifier, data, signer, options } = message

    try {
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret!
      const signerKeyObj = new PrivateKey(signerKey)
      const id = new Identifier(identifier)

      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await uploadSOC(target, signerKeyObj, id, data, {
            encryptionKey: options?.encrypt !== false ? true : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "socUploadResponse",
        requestId,
        reference: uint8ArrayToHex(result.socAddress),
        tagUid: result.tagUid,
        encryptionKey: result.encryptionKey
          ? uint8ArrayToHex(result.encryptionKey)
          : undefined,
        owner: signerKeyObj.publicKey().address().toHex(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC upload failed",
      )
    }
  }

  private async handleSocRawUpload(
    message: SocRawUploadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, identifier, data, signer, options } = message

    try {
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret!
      const signerKeyObj = new PrivateKey(signerKey)
      const id = new Identifier(identifier)

      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await uploadSOC(target, signerKeyObj, id, data, {
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "socRawUploadResponse",
        requestId,
        reference: uint8ArrayToHex(result.socAddress),
        tagUid: result.tagUid,
        encryptionKey: undefined,
        owner: signerKeyObj.publicKey().address().toHex(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC raw upload failed",
      )
    }
  }

  private async handleSocDownload(
    message: SocDownloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, owner, identifier, encryptionKey, requestOptions } =
      message

    try {
      let resolvedOwner = owner
      if (!resolvedOwner) {
        if (!this.appSecret) {
          throw new Error("Not authenticated. Please login first.")
        }
        resolvedOwner = new PrivateKey(this.appSecret)
          .publicKey()
          .address()
          .toHex()
      }

      const soc = await downloadEncryptedSOC(
        this.bee,
        resolvedOwner,
        identifier,
        encryptionKey,
        requestOptions,
      )

      this.postMessage(event, {
        type: "socDownloadResponse",
        requestId,
        data: soc.data,
        identifier: soc.identifier,
        signature: soc.signature,
        span: soc.span,
        payload: soc.payload,
        address: soc.address,
        owner: soc.owner,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC download failed",
      )
    }
  }

  private async handleSocRawDownload(
    message: SocRawDownloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, owner, identifier, encryptionKey, requestOptions } =
      message

    try {
      let resolvedOwner = owner
      if (!resolvedOwner) {
        if (!this.appSecret) {
          throw new Error("Not authenticated. Please login first.")
        }
        resolvedOwner = new PrivateKey(this.appSecret)
          .publicKey()
          .address()
          .toHex()
      }

      const soc = encryptionKey
        ? await downloadEncryptedSOC(
            this.bee,
            resolvedOwner,
            identifier,
            encryptionKey,
            requestOptions,
          )
        : await downloadSOC(this.bee, resolvedOwner, identifier, requestOptions)

      this.postMessage(event, {
        type: "socRawDownloadResponse",
        requestId,
        data: soc.data,
        identifier: soc.identifier,
        signature: soc.signature,
        span: soc.span,
        payload: soc.payload,
        address: soc.address,
        owner: soc.owner,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC raw download failed",
      )
    }
  }

  private async handleSocGetOwner(
    message: SocGetOwnerMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId } = message

    try {
      if (!this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const owner = new PrivateKey(this.appSecret).publicKey().address().toHex()

      this.postMessage(event, {
        type: "socGetOwnerResponse",
        requestId,
        owner,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "SOC get owner failed",
      )
    }
  }

  /**
   * Derive a stable, app-scoped secret HMAC(appSecret, label) for the connected
   * app. `appSecret` is genuinely secret (unlike the recoverable appKey public
   * key) and never leaves the iframe — only the derived bytes are returned, so
   * the app can seed an unguessable feed topic without exposing metadata (#520).
   */
  private async handleDeriveAppSecret(
    message: DeriveAppSecretMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, label } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const secretHex = await deriveSecret(this.appSecret, label)

      this.postMessage(event, {
        type: "deriveAppSecretResponse",
        requestId,
        secret: hexToUint8Array(secretHex),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "deriveAppSecret failed",
      )
    }
  }

  private parseFeedTimestamp(value: string | number): bigint {
    if (typeof value === "number") {
      return BigInt(Math.floor(value))
    }
    // Validate string is a valid integer representation
    if (!/^-?\d+$/.test(value)) {
      throw new Error(
        `Invalid timestamp format: "${value}" (expected decimal integer)`,
      )
    }
    return BigInt(value)
  }

  private parseFeedIndex(value: string | number): bigint {
    if (typeof value === "number") {
      return BigInt(Math.floor(value))
    }
    // Validate string is a valid integer representation
    if (!/^-?\d+$/.test(value)) {
      throw new Error(
        `Invalid index format: "${value}" (expected decimal integer)`,
      )
    }
    return BigInt(value)
  }

  private makeSequentialFeedIdentifier(
    topic: Uint8Array,
    index: bigint,
  ): Uint8Array {
    const indexBytes = Binary.numberToUint64(index, "BE")
    return Binary.keccak256(Binary.concatBytes(topic, indexBytes))
  }

  private async findLatestSequentialIndex(
    topic: Uint8Array,
    owner: EthAddress,
    requestOptions?: BeeRequestOptions,
    lookupTimeoutMs?: number,
  ): Promise<bigint | undefined> {
    const lookupOptions: BeeRequestOptions = {
      ...requestOptions,
      timeout: lookupTimeoutMs ?? SEQUENTIAL_INDEX_LOOKUP_TIMEOUT_MS,
    }
    const finder = createAsyncSequentialFinder({
      bee: this.bee,
      topic: new Topic(topic),
      owner,
    })
    const result = await finder.findAt(0n, 0n, lookupOptions)
    return result.current
  }

  private sequentialNextIndex(index: bigint): bigint {
    const max = (1n << 64n) - 1n
    return index === max ? 0n : index + 1n
  }

  private async handleFeedGetOwner(
    message: FeedGetOwnerMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId } = message

    try {
      if (!this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const owner = new PrivateKey(this.appSecret).publicKey().address().toHex()

      this.postMessage(event, {
        type: "feedGetOwnerResponse",
        requestId,
        owner,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "Feed get owner failed",
      )
    }
  }

  private async handleEpochFeedDownloadReference(
    message: EpochFeedDownloadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, topic, owner, at, after, encryptionKey } = message

    try {
      let resolvedOwner = owner
      if (!resolvedOwner) {
        if (!this.appSecret) {
          throw new Error("Not authenticated. Please login first.")
        }
        resolvedOwner = new PrivateKey(this.appSecret)
          .publicKey()
          .address()
          .toHex()
      }

      const topicObj = new Topic(hexToUint8Array(topic))
      const ownerObj = new EthAddress(resolvedOwner)
      const atValue = this.parseFeedTimestamp(at)
      const afterValue =
        after !== undefined ? this.parseFeedTimestamp(after) : 0n
      const epochKeyBytes = encryptionKey
        ? hexToUint8Array(encryptionKey)
        : undefined

      let reference: Uint8Array | undefined
      if (epochKeyBytes) {
        const encryptedFinder = createAsyncEpochFinder({
          bee: this.bee,
          topic: topicObj,
          owner: ownerObj,
          encryptionKey: epochKeyBytes,
        })
        reference = await encryptedFinder.findAt(atValue, afterValue)
      } else {
        const plainFinder = createAsyncEpochFinder({
          bee: this.bee,
          topic: topicObj,
          owner: ownerObj,
        })
        reference = await plainFinder.findAt(atValue, afterValue)
      }

      this.postMessage(event, {
        type: "epochFeedDownloadReferenceResponse",
        requestId,
        reference: reference ? uint8ArrayToHex(reference) : undefined,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Epoch feed download reference failed",
      )
    }
  }

  private async handleEpochFeedUploadReference(
    message: EpochFeedUploadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      at,
      reference,
      encryptionKey,
      hints,
      batchID,
    } = message

    try {
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret!
      const signerKeyObj = new PrivateKey(signerKey)
      const topicObj = new Topic(hexToUint8Array(topic))
      const ownerAddress = signerKeyObj.publicKey().address()
      const atValue = this.parseFeedTimestamp(at)
      const epochEncryptionKey = encryptionKey
        ? hexToUint8Array(encryptionKey)
        : undefined

      // Convert hints from message format to updater format
      const epochHints = hints?.lastEpoch
        ? {
            lastEpoch: {
              start: BigInt(hints.lastEpoch.start),
              level: hints.lastEpoch.level,
            },
            lastTimestamp: hints.lastTimestamp
              ? BigInt(hints.lastTimestamp)
              : undefined,
          }
        : undefined

      // Validate reference length
      const referenceBytes = hexToUint8Array(reference)
      if (referenceBytes.length !== 32 && referenceBytes.length !== 64) {
        throw new Error(
          `Reference must be 32 or 64 bytes, got ${referenceBytes.length}`,
        )
      }

      // Create updater - works with both stamper and subsidised modes
      const updater = createEpochUpdater({
        bee: this.bee,
        topic: topicObj,
        owner: ownerAddress,
        signer: signerKeyObj,
      })

      // Use mode-aware write lock for the upload operation. `batchID` targets
      // the feed SOC at the same batch the caller's payload went to — without
      // it an epoch write straddles two batches with independent TTLs.
      const updateResult = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          const result = await updater.update(
            atValue,
            referenceBytes,
            target,
            epochEncryptionKey,
            epochHints,
          )

          return result
        },
        batchID,
      )

      // Verify upload with read-back
      const readBackFinder = createAsyncEpochFinder({
        bee: this.bee,
        topic: topicObj,
        owner: ownerAddress,
        encryptionKey: epochEncryptionKey,
      })

      // Upload read-back should verify the exact timestamp write and avoid
      // broad fallback scans over historical leaves on poisoned networks.
      await readBackFinder.findAt(atValue, atValue)

      this.postMessage(event, {
        type: "epochFeedUploadReferenceResponse",
        requestId,
        socAddress: uint8ArrayToHex(updateResult.socAddress),
        encryptionKey: encryptionKey ? encryptionKey : undefined,
        epoch: {
          start: updateResult.epoch.start.toString(),
          level: updateResult.epoch.level,
        },
        timestamp: updateResult.timestamp.toString(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Epoch feed upload reference failed",
      )
    }
  }

  private async handleSequentialFeedGetOwner(
    message: SequentialFeedGetOwnerMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId } = message

    try {
      if (!this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      const owner = new PrivateKey(this.appSecret).publicKey().address().toHex()

      this.postMessage(event, {
        type: "seqFeedGetOwnerResponse",
        requestId,
        owner,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed get owner failed",
      )
    }
  }

  private async resolveSequentialOwner(owner?: string): Promise<string> {
    if (owner) {
      return owner
    }
    if (!this.appSecret) {
      throw new Error("Not authenticated. Please login first.")
    }
    return new PrivateKey(this.appSecret).publicKey().address().toHex()
  }

  private parseSequentialPayload(
    payload: Uint8Array,
    hasTimestamp: boolean,
  ): { payload: Uint8Array; timestamp?: number } {
    if (!hasTimestamp) {
      return { payload }
    }

    if (payload.length < 8) {
      return { payload, timestamp: undefined }
    }

    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    )
    const timestamp = Number(view.getBigUint64(0, false))
    return { payload: payload.slice(8), timestamp }
  }

  private async resolveSequentialIndex(
    topicBytes: Uint8Array,
    ownerAddress: EthAddress,
    index?: string | number,
    at?: string | number,
    hasTimestamp: boolean = true,
    requestOptions?: BeeRequestOptions,
    encryptionKey?: string,
    raw: boolean = false,
    lookupTimeoutMs?: number,
  ): Promise<bigint> {
    if (!raw && !encryptionKey) {
      throw new Error("Encryption key is required for encrypted feed lookup")
    }
    if (index !== undefined) {
      return this.parseFeedIndex(index)
    }

    const latest = await this.findLatestSequentialIndex(
      topicBytes,
      ownerAddress,
      requestOptions,
      lookupTimeoutMs,
    )
    if (latest === undefined) {
      throw new Error("Sequential feed has no updates")
    }

    if (at === undefined) {
      return latest
    }

    if (!hasTimestamp) {
      throw new Error("Cannot use 'at' without timestamps")
    }

    const atValue = this.parseFeedTimestamp(at)
    for (let current = latest; current >= 0n; current--) {
      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        current,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = raw
        ? encryptionKey
          ? await downloadEncryptedSOC(
              this.bee,
              ownerAddress,
              identifier,
              encryptionKey,
              requestOptions,
            )
          : await downloadSOC(
              this.bee,
              ownerAddress,
              identifier,
              requestOptions,
            )
        : await downloadEncryptedSOC(
            this.bee,
            ownerAddress,
            identifier,
            encryptionKey ?? "",
            requestOptions,
          )

      const parsed = this.parseSequentialPayload(soc.payload, true)
      if (
        parsed.timestamp !== undefined &&
        BigInt(parsed.timestamp) <= atValue
      ) {
        return current
      }
      if (current === 0n) {
        break
      }
    }

    // If no update matches the timestamp, fall back to latest for sequential feeds.
    return latest
  }

  private async handleSequentialFeedDownloadPayload(
    message: SequentialFeedDownloadPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      owner,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      requestOptions,
    } = message

    try {
      if (!encryptionKey) {
        throw new Error("Encryption key is required for downloadPayload")
      }

      const resolvedOwner = await this.resolveSequentialOwner(owner)
      const ownerAddress = new EthAddress(resolvedOwner)
      const topicBytes = hexToUint8Array(topic)
      const useTimestamp = hasTimestamp !== false
      const resolvedIndex = await this.resolveSequentialIndex(
        topicBytes,
        ownerAddress,
        index,
        at,
        useTimestamp,
        requestOptions,
        encryptionKey,
        false,
        lookupTimeoutMs,
      )

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = await downloadEncryptedSOC(
        this.bee,
        ownerAddress,
        identifier,
        encryptionKey,
        requestOptions,
      )

      const parsed = this.parseSequentialPayload(soc.payload, useTimestamp)
      const nextIndex = this.sequentialNextIndex(resolvedIndex)

      this.postMessage(event, {
        type: "seqFeedDownloadPayloadResponse",
        requestId,
        payload: parsed.payload,
        timestamp: parsed.timestamp,
        feedIndex: resolvedIndex.toString(),
        feedIndexNext: nextIndex.toString(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed download payload failed",
      )
    }
  }

  private async handleSequentialFeedDownloadRawPayload(
    message: SequentialFeedDownloadRawPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      owner,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      requestOptions,
    } = message

    try {
      const resolvedOwner = await this.resolveSequentialOwner(owner)
      const ownerAddress = new EthAddress(resolvedOwner)
      const topicBytes = hexToUint8Array(topic)
      const useTimestamp = hasTimestamp !== false
      const resolvedIndex = await this.resolveSequentialIndex(
        topicBytes,
        ownerAddress,
        index,
        at,
        useTimestamp,
        requestOptions,
        encryptionKey,
        true,
        lookupTimeoutMs,
      )

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = encryptionKey
        ? await downloadEncryptedSOC(
            this.bee,
            ownerAddress,
            identifier,
            encryptionKey,
            requestOptions,
          )
        : await downloadSOC(this.bee, ownerAddress, identifier, requestOptions)

      const parsed = this.parseSequentialPayload(soc.payload, useTimestamp)
      const nextIndex = this.sequentialNextIndex(resolvedIndex)

      this.postMessage(event, {
        type: "seqFeedDownloadRawPayloadResponse",
        requestId,
        payload: parsed.payload,
        timestamp: parsed.timestamp,
        feedIndex: resolvedIndex.toString(),
        feedIndexNext: nextIndex.toString(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed download raw payload failed",
      )
    }
  }

  private async handleSequentialFeedDownloadReference(
    message: SequentialFeedDownloadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      owner,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      requestOptions,
    } = message

    try {
      if (!encryptionKey) {
        throw new Error("Encryption key is required for downloadReference")
      }

      const resolvedOwner = await this.resolveSequentialOwner(owner)
      const ownerAddress = new EthAddress(resolvedOwner)
      const topicBytes = hexToUint8Array(topic)
      const useTimestamp = hasTimestamp !== false
      const resolvedIndex = await this.resolveSequentialIndex(
        topicBytes,
        ownerAddress,
        index,
        at,
        useTimestamp,
        requestOptions,
        encryptionKey,
        false,
        lookupTimeoutMs,
      )

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)
      const soc = await downloadEncryptedSOC(
        this.bee,
        ownerAddress,
        identifier,
        encryptionKey,
        requestOptions,
      )

      const parsed = this.parseSequentialPayload(soc.payload, useTimestamp)
      if (parsed.payload.length !== 32 && parsed.payload.length !== 64) {
        throw new Error(
          "Sequential feed update does not contain a reference; use downloadPayload",
        )
      }
      const referenceHex = uint8ArrayToHex(parsed.payload)
      const nextIndex = this.sequentialNextIndex(resolvedIndex)

      this.postMessage(event, {
        type: "seqFeedDownloadReferenceResponse",
        requestId,
        reference: referenceHex,
        feedIndex: resolvedIndex.toString(),
        feedIndexNext: nextIndex.toString(),
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed download reference failed",
      )
    }
  }

  private buildSequentialPayload(
    data: Uint8Array,
    hasTimestamp: boolean,
    at: bigint,
  ): Uint8Array {
    if (!hasTimestamp) {
      return data
    }
    const timestamp = new Uint8Array(8)
    const view = new DataView(timestamp.buffer)
    view.setBigUint64(0, at, false)
    return Binary.concatBytes(timestamp, data)
  }

  private async handleSequentialFeedUploadPayload(
    message: SequentialFeedUploadPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      data,
      index,
      at,
      hasTimestamp,
      lookupTimeoutMs,
      options,
      requestOptions,
    } = message

    try {
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret!
      const signerKeyObj = new PrivateKey(signerKey)
      const ownerAddress = signerKeyObj.publicKey().address()
      const topicBytes = hexToUint8Array(topic)

      const useTimestamp = hasTimestamp !== false
      const atValue =
        at !== undefined
          ? this.parseFeedTimestamp(at)
          : BigInt(Math.floor(Date.now() / 1000))
      let resolvedIndex: bigint
      if (index !== undefined) {
        resolvedIndex = this.parseFeedIndex(index)
      } else {
        const latest = await this.findLatestSequentialIndex(
          topicBytes,
          ownerAddress,
          requestOptions,
          lookupTimeoutMs,
        )
        resolvedIndex =
          latest === undefined ? 0n : this.sequentialNextIndex(latest)
      }

      const payload = this.buildSequentialPayload(data, useTimestamp, atValue)
      if (payload.length < 1 || payload.length > 4096) {
        throw new Error(
          `Invalid payload length: ${payload.length} (expected 1-4096)`,
        )
      }

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)

      // Upload SOC with optional encryption (enabled by default)
      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await uploadSOC(target, signerKeyObj, identifier, payload, {
            encryptionKey: options?.encrypt !== false ? true : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "seqFeedUploadPayloadResponse",
        requestId,
        reference: uint8ArrayToHex(result.socAddress),
        feedIndex: resolvedIndex.toString(),
        owner: ownerAddress.toHex(),
        encryptionKey: result.encryptionKey
          ? uint8ArrayToHex(result.encryptionKey)
          : undefined,
        tagUid: result.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed upload payload failed",
      )
    }
  }

  private async handleSequentialFeedUploadRawPayload(
    message: SequentialFeedUploadRawPayloadMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      data,
      index,
      at,
      hasTimestamp,
      encryptionKey,
      lookupTimeoutMs,
      options,
      requestOptions,
    } = message

    try {
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret!
      const signerKeyObj = new PrivateKey(signerKey)
      const ownerAddress = signerKeyObj.publicKey().address()
      const topicBytes = hexToUint8Array(topic)

      const useTimestamp = hasTimestamp !== false
      const atValue =
        at !== undefined
          ? this.parseFeedTimestamp(at)
          : BigInt(Math.floor(Date.now() / 1000))
      let resolvedIndex: bigint
      if (index !== undefined) {
        resolvedIndex = this.parseFeedIndex(index)
      } else {
        const latest = await this.findLatestSequentialIndex(
          topicBytes,
          ownerAddress,
          requestOptions,
          lookupTimeoutMs,
        )
        resolvedIndex =
          latest === undefined ? 0n : this.sequentialNextIndex(latest)
      }

      const payload = this.buildSequentialPayload(data, useTimestamp, atValue)
      if (payload.length < 1 || payload.length > 4096) {
        throw new Error(
          `Invalid payload length: ${payload.length} (expected 1-4096)`,
        )
      }

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)

      // Upload SOC - use encryption if key provided, otherwise plain SOC
      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await uploadSOC(target, signerKeyObj, identifier, payload, {
            encryptionKey: encryptionKey
              ? hexToUint8Array(encryptionKey)
              : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "seqFeedUploadRawPayloadResponse",
        requestId,
        reference: uint8ArrayToHex(result.socAddress),
        feedIndex: resolvedIndex.toString(),
        owner: ownerAddress.toHex(),
        encryptionKey: encryptionKey ? encryptionKey : undefined,
        tagUid: result.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed upload raw payload failed",
      )
    }
  }

  private async handleSequentialFeedUploadReference(
    message: SequentialFeedUploadReferenceMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      topic,
      signer,
      reference,
      index,
      at,
      hasTimestamp,
      lookupTimeoutMs,
      options,
      requestOptions,
    } = message

    try {
      this.ensureCanUpload()

      const signerKey = signer ?? this.appSecret!
      const signerKeyObj = new PrivateKey(signerKey)
      const ownerAddress = signerKeyObj.publicKey().address()
      const topicBytes = hexToUint8Array(topic)

      const useTimestamp = hasTimestamp !== false
      const atValue =
        at !== undefined
          ? this.parseFeedTimestamp(at)
          : BigInt(Math.floor(Date.now() / 1000))
      let resolvedIndex: bigint
      if (index !== undefined) {
        resolvedIndex = this.parseFeedIndex(index)
      } else {
        const latest = await this.findLatestSequentialIndex(
          topicBytes,
          ownerAddress,
          requestOptions,
          lookupTimeoutMs,
        )
        resolvedIndex =
          latest === undefined ? 0n : this.sequentialNextIndex(latest)
      }

      const referenceBytes = hexToUint8Array(reference)
      const payload = this.buildSequentialPayload(
        referenceBytes,
        useTimestamp,
        atValue,
      )
      if (payload.length < 1 || payload.length > 4096) {
        throw new Error(
          `Invalid payload length: ${payload.length} (expected 1-4096)`,
        )
      }

      const identifierBytes = this.makeSequentialFeedIdentifier(
        topicBytes,
        resolvedIndex,
      )
      const identifier = new Identifier(identifierBytes)

      // uploadReference always uses encryption with auto-generated key
      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await uploadSOC(target, signerKeyObj, identifier, payload, {
            encryptionKey: true,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
          })
        },
        options?.batchID,
      )

      this.postMessage(event, {
        type: "seqFeedUploadReferenceResponse",
        requestId,
        reference: uint8ArrayToHex(result.socAddress),
        feedIndex: resolvedIndex.toString(),
        owner: ownerAddress.toHex(),
        encryptionKey: result.encryptionKey
          ? uint8ArrayToHex(result.encryptionKey)
          : undefined,
        tagUid: result.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error
          ? error.message
          : "Sequential feed upload reference failed",
      )
    }
  }

  // ============================================================================
  // ACT (Access Control Tries) Handlers
  // ============================================================================

  private async handleActUploadData(
    message: ActUploadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      data,
      grantees,
      options,
      requestOptions,
      enableProgress,
    } = message

    try {
      this.ensureCanUpload()

      // Parse grantee public keys from compressed hex
      const granteePublicKeys = grantees.map((hex) =>
        parseCompressedPublicKey(hex),
      )

      // Progress callback (if enabled)
      const onProgress = this.createProgressCallback(
        event,
        requestId,
        enableProgress,
      )

      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret!)
      const beeCompatible = options?.beeCompatible === true

      const { actResult, contentUpload } = await this.withModeAwareWriteLock(
        { useWorkers: true },
        async (target) => {
          // Step 1: Upload raw content data (encrypted by default for 64-byte reference)
          const contentUploadResult = await uploadData(target, data, {
            encryptionKey: options?.encrypt !== false ? true : undefined,
            pin: options?.pin,
            deferred: options?.deferred,
            tag: options?.tag,
            onProgress,
            requestOptions,
          })

          // Step 2: Create Mantaray manifest wrapping the content
          // Content reference is 64 bytes (encrypted reference: address + encryption key)
          const manifest = new MantarayNode()
          const contentReferenceBytes = hexToUint8Array(
            contentUploadResult.reference,
          )
          manifest.addFork(DEFAULT_ACT_FILENAME, contentReferenceBytes, {
            "Content-Type": DEFAULT_ACT_CONTENT_TYPE,
            Filename: DEFAULT_ACT_FILENAME,
          })
          manifest.addFork("/", NULL_ADDRESS, {
            "website-index-document": DEFAULT_ACT_FILENAME,
          })

          // Step 3: Upload the Mantaray manifest
          const manifestResult = await saveMantarayTree(
            manifest,
            async (chunkData) => {
              await uploadChunk(target, chunkData, {
                pin: options?.pin,
                deferred: options?.deferred,
                tag: options?.tag,
              })
              return {}
            },
            { encrypt: !beeCompatible },
          )

          // Step 4: Use manifest reference for ACT encryption
          const manifestReferenceBytes = hexToUint8Array(
            manifestResult.rootReference,
          )

          // Create ACT for the manifest (which points to the content)
          const actResultValue = await createActForContent(
            target,
            manifestReferenceBytes,
            publisherPrivateKey,
            granteePublicKeys,
            options,
            requestOptions,
          )

          return {
            actResult: actResultValue,
            contentUpload: contentUploadResult,
          }
        },
        options?.batchID,
      )

      // Send final response
      this.postMessage(event, {
        type: "actUploadDataResponse",
        requestId,
        encryptedReference: actResult.encryptedReference,
        historyReference: actResult.historyReference,
        granteeListReference: actResult.granteeListReference,
        publisherPubKey: actResult.publisherPubKey,
        actReference: actResult.actReference,
        tagUid: contentUpload.tagUid,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT upload failed",
      )
    }
  }

  private async handleActDownloadData(
    message: ActDownloadDataMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      encryptedReference,
      historyReference,
      publisherPubKey,
      timestamp,
      requestOptions,
    } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      // appSecret is already checked by authenticated check above
      // Use appSecret as reader private key (user's identity key for this app)
      const readerPrivateKey = hexToUint8Array(this.appSecret)

      // Decrypt the ACT reference to get the content reference
      const contentReference = await decryptActReference(
        this.bee,
        encryptedReference,
        historyReference,
        publisherPubKey,
        readerPrivateKey,
        timestamp,
        requestOptions,
      )

      // Step 1: Download and unmarshal the Mantaray manifest (chunk API only)
      const manifest = await loadMantarayTreeWithChunkAPI(
        this.bee,
        contentReference,
        requestOptions,
      )

      // Step 2: Get the index document path from manifest metadata
      const { indexDocument } = manifest.getDocsMetadata()
      if (!indexDocument) {
        throw new Error("Manifest does not contain an index document reference")
      }

      // Step 3: Find the node at the index document path
      const contentNode = manifest.find(indexDocument)
      if (!contentNode) {
        throw new Error(`Content node "${indexDocument}" not found in manifest`)
      }

      if (!contentNode.targetAddress) {
        throw new Error(
          `Content node "${indexDocument}" does not have a target address`,
        )
      }

      const actualContentRef = uint8ArrayToHex(contentNode.targetAddress)

      // Step 4: Download the actual content
      const data = await downloadDataWithChunkAPI(
        this.bee,
        actualContentRef,
        undefined,
        undefined,
        requestOptions,
      )

      this.postMessage(event, {
        type: "actDownloadDataResponse",
        requestId,
        data: data as Uint8Array,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT download failed",
      )
    }
  }

  private async handleActAddGrantees(
    message: ActAddGranteesMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, historyReference, grantees, requestOptions } = message

    try {
      this.ensureCanUpload()

      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret!)

      // Parse grantee public keys from compressed hex
      const newGranteePublicKeys = grantees.map((hex) =>
        parseCompressedPublicKey(hex),
      )

      // Add grantees to ACT
      const result = await this.withModeAwareWriteLock(
        { useWorkers: true },
        async (target) => {
          return await addGranteesToAct(
            target,
            this.bee,
            historyReference,
            publisherPrivateKey,
            newGranteePublicKeys,
            undefined,
            requestOptions,
          )
        },
      )

      this.postMessage(event, {
        type: "actAddGranteesResponse",
        requestId,
        historyReference: result.historyReference,
        granteeListReference: result.granteeListReference,
        actReference: result.actReference,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT add grantees failed",
      )
    }
  }

  private async handleActRevokeGrantees(
    message: ActRevokeGranteesMessage,
    event: MessageEvent,
  ): Promise<void> {
    const {
      requestId,
      historyReference,
      encryptedReference,
      revokeGrantees,
      requestOptions,
    } = message

    try {
      this.ensureCanUpload()

      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret!)

      // Parse grantee public keys from compressed hex
      const revokePublicKeys = revokeGrantees.map((hex) =>
        parseCompressedPublicKey(hex),
      )

      // Revoke grantees from ACT (drops their entries; reference unchanged, #496)
      const result = await this.withModeAwareWriteLock(
        { useWorkers: true },
        async (target) => {
          return await revokeGranteesFromAct(
            target,
            this.bee,
            historyReference,
            encryptedReference,
            publisherPrivateKey,
            revokePublicKeys,
            undefined,
            requestOptions,
          )
        },
      )

      this.postMessage(event, {
        type: "actRevokeGranteesResponse",
        requestId,
        encryptedReference: result.encryptedReference,
        historyReference: result.historyReference,
        granteeListReference: result.granteeListReference,
        actReference: result.actReference,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT revoke grantees failed",
      )
    }
  }

  private async handleActGetGrantees(
    message: ActGetGranteesMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { requestId, historyReference, requestOptions } = message

    try {
      if (!this.authenticated || !this.appSecret) {
        throw new Error("Not authenticated. Please login first.")
      }

      // appSecret is already checked by authenticated check above
      // Use appSecret as publisher private key (user's identity key for this app)
      const publisherPrivateKey = hexToUint8Array(this.appSecret)

      // Get grantees from ACT
      const grantees = await getGranteesFromAct(
        this.bee,
        historyReference,
        publisherPrivateKey,
        requestOptions,
      )

      this.postMessage(event, {
        type: "actGetGranteesResponse",
        requestId,
        grantees,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        requestId,
        error instanceof Error ? error.message : "ACT get grantees failed",
      )
    }
  }

  /**
   * @deprecated Compat shim for already-deployed pre-multi-batch clients (see
   * `GetPostageBatchMessageSchema`): answers the removed `getPostageBatch`
   * request with the resolved default stamp, enriched exactly like the list
   * endpoint. Without this the message is silently dropped and the old dApp's
   * request hangs to its timeout on every stamp display.
   */
  private async handleLegacyGetPostageBatch(
    message: GetPostageBatchMessage,
    event: MessageEvent,
  ): Promise<void> {
    const stamp = this.lookupPostageStampForApp()
    let postageBatch: PostageBatch | undefined
    if (stamp) {
      let price: Promise<number> | undefined
      const getPrice = () => (price ??= fetchSwarmPrice())
      postageBatch = {
        ...(await this.stampToPostageBatch(stamp, getPrice)),
        isDefault: true,
      }
    }
    this.postMessage(event, {
      type: "getPostageBatchResponse",
      requestId: message.requestId,
      postageBatch,
    })
  }

  private async handleGetPostageBatches(
    message: GetPostageBatchesMessage,
    event: MessageEvent,
  ): Promise<void> {
    // Expose every stamp (a "drive") the account owns, not just the resolved
    // default — tombstoned stamps excluded. The resolved default is flagged so
    // clients can tell which stamp untargeted uploads actually consume.
    const connection = this.findConnectionForParent()
    const stamps =
      connection?.account.postageStamps.filter((s) => !s.deletedAt) ?? []
    // Falls back to the LIVE binding when no default resolves: a targeted write
    // may have promoted an owned stamp to the binding on an account whose
    // default pointer is gone (see `resolveUploadStamper`), and untargeted
    // uploads then consume it. Without this, `isDefault` is false for every
    // batch while uploads keep succeeding on one, and the documented
    // `find((b) => b.isDefault)` migration recipe reports nothing.
    const defaultStamp =
      (connection
        ? resolveStampForApp(connection.app, connection.account, stamps)
        : undefined) ??
      stamps.find((s) => s.batchID.toHex() === this.postageBatchId)

    // The Swarmscan price is batch-independent — fetch it at most once per
    // request, shared across all stamps' fallback paths.
    let price: Promise<number> | undefined
    const getPrice = () => (price ??= fetchSwarmPrice())

    const postageBatches = await Promise.all(
      stamps.map(async (stamp) => ({
        ...(await this.stampToPostageBatch(stamp, getPrice)),
        isDefault: stamp === defaultStamp,
      })),
    )

    this.postMessage(event, {
      type: "getPostageBatchesResponse",
      requestId: message.requestId,
      postageBatches,
    })
  }

  /**
   * Map a stored PostageStamp to the public PostageBatch (minus `isDefault`,
   * which only the request-level caller can resolve), enriching the stale
   * stored snapshot with live `usable`/`exists`/`batchTTL`. Excludes signerKey.
   * The live lookups are bounded by {@link STAMP_ENRICH_TIMEOUT_MS}; on timeout
   * or failure the stored snapshot is served instead, so one hung RPC can't
   * time out the whole client request.
   */
  private async stampToPostageBatch(
    stamp: PostageStamp,
    getPrice: () => Promise<number>,
  ): Promise<Omit<PostageBatch, "isDefault">> {
    const batchIdHex = stamp.batchID.toHex()

    const enrich = async (): Promise<{
      details: BatchDetails | undefined
      batchTTL: number | undefined
    }> => {
      // The stored stamp's `usable`/`exists` are a snapshot from assignment
      // time and can be stale (e.g. a batch assigned during its ~30s warm-up
      // stays `usable: false` in storage forever), so read live batch details
      // from the Bee node for those fields.
      //
      // Started but NOT awaited here: the contract read below is independent,
      // and both together must fit inside STAMP_ENRICH_TIMEOUT_MS — in series
      // their sum can trip a timeout that their max would not.
      const detailsPromise = fetchBatchDetails(this.beeApiUrl, batchIdHex)

      // TTL from live chain state via the canonical lookup: the PostageStamp
      // contract first (ground truth for any batch, even one this Bee node has
      // never seen), then the node's `batchTTL` — handed over from the details
      // request already in flight, so the node is never asked twice. Fall back
      // to the Swarmscan-price approximation only when neither can answer.
      let batchTTL = await fetchAuthoritativeBatchTTL(
        this.gnosisRpcUrl,
        this.beeApiUrl,
        batchIdHex,
        this.postageStampContractAddress,
        detailsPromise.then((d) => d?.batchTTL),
      )
      const details = await detailsPromise
      if (batchTTL === undefined) {
        try {
          batchTTL = calculateTTLSeconds(stamp.amount, await getPrice())
        } catch (error) {
          console.warn("[Proxy] Failed to calculate TTL:", error)
        }
      }
      return { details, batchTTL }
    }

    let details: BatchDetails | undefined
    let batchTTL: number | undefined
    try {
      ;({ details, batchTTL } = await withTimeout(
        enrich(),
        STAMP_ENRICH_TIMEOUT_MS,
        `Stamp enrichment for ${batchIdHex} timed out`,
      ))
    } catch (error) {
      console.warn("[Proxy] Stamp enrichment failed; serving snapshot:", error)
    }

    return {
      batchID: batchIdHex,
      utilization: stamp.utilization,
      usable: details?.usable ?? stamp.usable,
      // The user-given drive name; "" for stamps named before naming existed
      // or bought outside the app (clients fall back to a batch-ID-derived
      // label, like the identity UI does).
      label: stamp.name ?? "",
      depth: stamp.depth,
      amount: stamp.amount.toString(),
      bucketDepth: stamp.bucketDepth,
      blockNumber: stamp.blockNumber,
      immutableFlag: stamp.immutableFlag,
      exists: details?.exists ?? stamp.exists,
      batchTTL,
    }
  }

  /**
   * Handle createFeedManifest request
   * Creates a feed manifest for accessing feed content via URL
   */
  private async handleCreateFeedManifest(
    message: CreateFeedManifestMessage,
    event: MessageEvent,
  ): Promise<void> {
    const { topic, owner, feedType, uploadOptions } = message

    // Resolve owner - use provided or fall back to app signer
    let resolvedOwner = owner
    if (!resolvedOwner && this.appSecret) {
      const signerKeyObj = new PrivateKey(this.appSecret)
      resolvedOwner = signerKeyObj.publicKey().address().toHex()
    }

    if (!resolvedOwner) {
      this.sendErrorToParent(
        event,
        message.requestId,
        "No owner provided and no app signer available",
      )
      return
    }

    try {
      this.ensureCanUpload()

      const result = await this.withModeAwareWriteLock(
        undefined,
        async (target) => {
          return await createFeedManifestDirect(
            target,
            topic,
            resolvedOwner,
            {
              encrypt: uploadOptions?.encrypt !== false,
              feedType,
            },
            uploadOptions,
          )
        },
        uploadOptions?.batchID,
      )

      this.postMessage(event, {
        type: "createFeedManifestResponse",
        requestId: message.requestId,
        reference: result.reference,
      })
    } catch (error) {
      this.sendErrorToParent(
        event,
        message.requestId,
        error instanceof Error ? error.message : "Create feed manifest failed",
      )
    }
  }
}

/**
 * Optional configuration for the proxy, supplied by the host trusted-domain app.
 */
export interface ProxyConfig {
  /**
   * PostageStamp contract address for on-chain stamp-TTL reads. Defaults to the
   * Gnosis mainnet deployment; set this (from a build-time env) to the local
   * bee-compose anvil address when developing against a local chain.
   */
  postageStampContractAddress?: string
}

/**
 * Initialize the proxy (called from HTML page)
 */
export function initProxy(config?: ProxyConfig): SwarmIdProxy {
  return new SwarmIdProxy(config)
}
