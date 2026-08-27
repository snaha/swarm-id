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
import { AccountBus, BroadcastChannelTransport } from "./bus/account-bus"
import { SignalingTransport } from "./bus/signaling-transport"
import { accountStateSnapshot } from "./utils/account-state-snapshot"
import { deriveBusContext } from "./bus/bus-context"
import type { BusContext } from "./bus/bus-context"
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
  foldAccount,
  foldedToSyncedAccount,
  publishDeviceState,
  readRoster,
} from "./sync"
import type { DeviceStateSnapshot } from "./sync"
import { mergeDevicesList } from "./sync/merge-snapshot"
import {
  accountDeltaSnapshot,
  restoreLocalSessionFields,
} from "./bus/account-delta"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { UtilizationStoreDB } from "./storage/utilization-store"
import type { PartitionLeaseStateSnapshot } from "./sync/partition-lease"
import { BatchWriteCoordinator } from "./sync/batch-write-coordinator"
import {
  getOrCreateDeviceId,
  deviceRegistryChanged,
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
} from "./utils/ttl"
import {
  fetchAuthoritativeBatchTTL,
  POSTAGE_STAMP_CONTRACT_ADDRESS,
} from "./utils/postage-contract"
import { tryCreateTag } from "./utils/tag"
import { accountToStateSnapshot } from "./utils/account-state-snapshot"
import {
  DEFAULT_BEE_NODE_URL,
  DEFAULT_GNOSIS_RPC_URL,
  isSignedOutAccount,
  type AccountStateSnapshot,
  type SignedInAccount,
  type SyncedAccount,
  type NetworkSettings,
} from "./schemas"
import { DEFAULT_SESSION_DURATION } from "./utils/constants"
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

/**
 * Gap between consecutive ranks when holders take turns answering a peer's
 * `lease-request` (`yieldRankDelayMs`). It budgets ONE bus hop — the winner's
 * `lease-claim`, which it publishes before it starts releasing (instant over
 * BroadcastChannel, a server round trip over signaling) — and nothing else.
 * Sizing it against the release itself would be hopeless: that is two stamped
 * Swarm writes, so no step short enough to keep the fallthrough useful could
 * ever gate it.
 */
const PEER_YIELD_RANK_STEP_MS = 250

/** Hex chars of request id — parsed straight into the rank seed. */
const LEASE_REQUEST_ID_LENGTH = 8

/** Request ids remembered as already answered, so a `lease-claim` can still
 *  call off a yield whose rank timer has fired. Small: a round's id is spent
 *  the moment a holder claims it, and stale entries only cost a `Set` slot. */
const ANSWERED_REQUEST_MEMORY = 32

/** Identifies one slot-wait round, so every holder ranks itself the same way.
 *  A UUID's first block is hex, so this is hex without any rewriting. */
function newLeaseRequestId(): string {
  return crypto.randomUUID().slice(0, LEASE_REQUEST_ID_LENGTH)
}

const DEFAULT_ACT_FILENAME = "index.bin"
const DEFAULT_ACT_CONTENT_TYPE = "application/octet-stream"
const SEQUENTIAL_INDEX_LOOKUP_TIMEOUT_MS = 2000

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
 * A hydrated account as the account-state snapshot the fold consumes.
 *
 * The record's OWN `lastModified` is the snapshot clock, never `Date.now()`:
 * this side of the fold is a record being re-read, not a change being made, and
 * a fresh clock on it would let this session outrank the peer's genuine edit.
 * (`accountToStateSnapshot` keeps the same rule per scalar field.)
 */
function accountAsStateSnapshot(
  account: SignedInAccount,
): AccountStateSnapshot {
  return accountToStateSnapshot(
    account,
    account.id.toHex(),
    account.lastModified ?? account.createdAt,
  )
}

/**
 * One side of an `account-delta` fold, in the shape `foldAccount` merges.
 *
 * Both sides go through it so the bus fold IS the Swarm fold — same collection
 * tombstone clocks, same per-field scalar clocks, same `BatchId` revival — with
 * no rule stated twice. `deviceId` is inert: the fold keys collections by their
 * own natural keys and takes the device list from its second argument.
 */
function deltaFoldView(snapshot: AccountStateSnapshot): DeviceStateSnapshot {
  return {
    version: 1,
    accountId: snapshot.accountId,
    deviceId: "",
    timestamp: snapshot.timestamp,
    ...accountStateToDeviceView(snapshot),
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
  private stampWorkerPool: StampWorkerPool | undefined
  private storagePartitioned: boolean = false
  private pendingChallenge: string | undefined
  private storagePartitionedIdentity: ConnectionIdentity | undefined
  /**
   * Hydrated account view for the storage-partitioning fallback: the synced
   * projection handed over by the connect popup (`AuthData.account`), held in
   * memory only — the stored-account schema requires a vault, and partitioned
   * sessions already re-handshake per iframe load. When set, the proxy is a
   * first-class writer despite the partition (docs/Account-Bus.md, phase 3).
   */
  private partitionAccount: SignedInAccount | undefined
  /** Account-derived topic the attached bus transports share; undefined when
   *  none are attached. */
  private busTopic: string | undefined
  private removeBusLocal: (() => void) | undefined
  private removeBusSignaling: (() => void) | undefined
  /** Derivation key of a join that attached everything it wanted. Lets the
   *  synchronous `joinAccountBus` return without re-deriving, and — because it
   *  stays unset when a transport failed to attach — makes the next join a
   *  RETRY rather than a dedup'd no-op. */
  private busJoinedKey: string | undefined
  /** Bumped by every bus join and by `clearAuthData`, so a join whose key
   *  derivation is still in flight can tell it has been superseded. */
  private busJoinGeneration = 0
  /** Account whose room the attached transports currently speak into. A
   *  transport encrypts with its construction-time key, so this — not whichever
   *  connection resolves now — is who a publish actually reaches. */
  private busBoundAccountId: string | undefined
  /** Account the live coordinator serves — routes bus lease messages. */
  private coordinatorAccountId: string | undefined
  /** Scheduled answers to peers' `lease-request`s, by request id, so a peer
   *  earlier in the rank order can call ours off (`yieldRankDelayMs`). */
  private pendingYields = new Map<string, ReturnType<typeof setTimeout>>()
  /** Request ids somebody has claimed (us or a peer). Insertion-ordered and
   *  capped at `ANSWERED_REQUEST_MEMORY`. Separate from `pendingYields`
   *  because the cancel window has to outlive the rank timer: the timer only
   *  starts the yield, whose first Swarm write is still ahead of it. */
  private answeredRequests = new Set<string>()
  /**
   * Utilization deltas that arrived while the stamper had no lane, held until
   * a bind names one (`applyPendingLaneUpdate`). Keyed by lane so a delta for
   * a lane we do not end up binding cannot displace the one we do — the point
   * of buffering is that nothing is silently lost. Buckets merge per index
   * with `max`, matching `applyUtilizationUpdate`'s own monotonic rule.
   * Bounded by the account's partition count.
   */
  private pendingLaneUpdates = new Map<string, Map<number, number>>()
  private utilizationStore: UtilizationStoreDB | undefined
  private beeApiUrl: string
  private gnosisRpcUrl: string
  private postageStampContractAddress: string
  private signalingUrl: string | undefined
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
  private bus: AccountBus
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
    this.signalingUrl = config?.signalingUrl
    if (!this.signalingUrl) {
      // Said out loud because the alternative is silence: without a URL the
      // bus never leaves this origin+partition, and a static build that lost
      // its `PUBLIC_BUS_SIGNALING_URL` looks exactly like a healthy one.
      console.info(
        "[Proxy] No account-bus signaling URL configured — cross-partition and cross-device coordination is off (docs/Account-Bus.md).",
      )
    }
    this.bee = new Bee(this.beeApiUrl)
    this.setupMessageListener()
    this.setupStorageListeners()

    // Multi-tab coordination rides the account bus (docs/Account-Bus.md).
    this.bus = new AccountBus([])
    this.setupBusListeners()

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

    // The account is the single nested document of record (it owns its
    // connected apps and postage stamps), so one subscription covers every
    // change that can affect auth or derived ConnectionInfo.
    const accountsManager = createAccountsStorageManager()
    this.unsubscribeStorageListeners.push(
      accountsManager.subscribe(() => {
        this.enqueueReconcile("handleAccountStorageChange", () =>
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
   * Queue a reconcile behind whatever reconcile is already running.
   *
   * `refreshStampFromStorage` / `initializeStamper` mutate shared
   * `stamper` / `postageBatchId` state across awaits, so two of them in flight
   * at once emit inconsistent ConnectionInfo. ONE queue for every source: a
   * storage event and an `account-delta` fold are the same work arriving two
   * ways, and a queue each would serialize neither against the other.
   *
   * Rejections are caught and logged here — the chain must survive one failure,
   * and nothing else catches them (the bus dispatch's try/catch only covers a
   * synchronous throw).
   */
  private enqueueReconcile(where: string, work: () => Promise<void>): void {
    this.storageWorkQueue = this.storageWorkQueue.then(() =>
      work().catch((error: unknown) => {
        console.error(`[Proxy] ${where} failed:`, error)
      }),
    )
  }

  /**
   * Re-read network settings and repoint the Bee client at the configured node.
   * `beeApiUrl` / `gnosisRpcUrl` are read fresh per call by the TTL/contract
   * helpers, so only the cached `this.bee` needs rebuilding. No-op when the Bee
   * URL is unchanged, so an RPC-only change doesn't churn the client mid-op.
   */
  private applyNetworkSettings(): void {
    this.applyNetworkSettingsValues(
      createNetworkSettingsStorageManager().load(),
    )
  }

  /**
   * The body of `applyNetworkSettings`, taking the settings as a value: a
   * partitioned session cannot read them from storage and is handed them by
   * the connect popup instead (`hydratePartitionAccount`). One implementation,
   * or the two paths drift — an RPC-only change is invisible to a `beeNodeUrl`
   * guard, and the subsidised-gateway rules below are easy to forget.
   */
  private applyNetworkSettingsValues(
    settings: NetworkSettings | undefined,
  ): void {
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
  }

  /**
   * Handle changes to the nested account document (triggered by storage events
   * from other windows). Covers auth transitions (connect / secret change /
   * disconnect) AND derived-ConnectionInfo changes (default-stamp change, new
   * stamp purchased, account rename) — all of which now live in one document.
   */
  private async handleAccountStorageChange(): Promise<void> {
    await this.reevaluateConnection("storage")
  }

  /**
   * Re-resolve this origin's connection and reconcile the session with it.
   *
   * `source` is where the news came from, and only the disconnect branch cares.
   * A partitioned iframe cannot see connected apps in storage, so a storage
   * event saying "no valid connection" means nothing there — but an
   * `account-delta` from a peer is authoritative, and acting on it is the whole
   * point of that message (docs/Account-Bus.md).
   */
  private async reevaluateConnection(source: "storage" | "bus"): Promise<void> {
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
        // override, rename) may have changed. A partitioned session skips this
        // for a storage event, whose account document it cannot read; after a
        // bus fold it must NOT skip it, because the hydrated view it just
        // folded into is exactly what the refresh reads (the same call
        // `hydratePartitionAccount` makes). Otherwise a rotated signer key or a
        // deleted stamp updates the view and leaves the live stamper stale for
        // the page's life.
        if (!this.storagePartitioned || source === "bus") {
          await this.refreshStampFromStorage()
        }
        this.emitConnectionInfoIfChanged()
      }

      // Propagate the account-state change to peers: over the bus always, and
      // to the shared feed when we hold a partition. Debounced so a burst
      // collapses into one of each. A delta we folded ourselves is not
      // re-broadcast (`source === "bus"`) — the publisher already reached
      // everyone in the room, and echoing it back is a loop.
      //
      // No coordinator gate: a session without one (a stamp-less account never
      // gets past `initializeStamper`) has nothing to write to the feed, but a
      // bus message needs no lease — and a stamp-less account still has apps to
      // revoke and partitioned sessions to tell.
      if (source === "storage") {
        this.schedulePublish("change")
      }
    } else if (
      this.authenticated &&
      (!this.storagePartitioned || source === "bus")
    ) {
      // No valid connection any more, and we're authenticated — disconnect.
      // A storage event is skipped while partitioned: the iframe can't see
      // connected apps, and auth was established via postMessage. A bus delta
      // is not — it IS the channel a revoke reaches a partitioned session by.
      // `clearAuthData` emits the ConnectionInfo update; no need to do so again.
      if (source === "storage") {
        // Relay the end of the session to peers that cannot see it. With only
        // this dApp open, this iframe is the ONLY context that reads the
        // account document, so its own partitioned sessions hear about the
        // revoke here or not at all. Storage-sourced only: a bus-sourced
        // disconnect came from a peer that already told the room, and echoing
        // it back is a loop. Ahead of `clearAuthData`, which detaches the
        // transports and rewrites the entry we are reporting.
        this.publishAccountDelta({ ofEndedConnection: true })
      }
      this.clearAuthData()
      this.sendToParent({
        type: "disconnectResponse",
        requestId: source === "bus" ? "account-delta" : "storage-event",
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
    if (this.isDownloadOnlyPartition) {
      return
    }

    // A rebound account is a different bus topic.
    this.joinAccountBus()

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

    this.postageBatchId = nextBatchId
    this.signerKey = nextSignerKey
    this.stamper = undefined
    this.stamperAccountFingerprint = undefined

    if (stamp) {
      await this.initializeStamper(stamp.depth)
    }
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
    this.partitionAccount = undefined
    this.authLoading = false
    this.isConnecting = false
    // Capture the device identity once, now, while we can read first-party
    // localStorage. Reused for every lease op so the identity never shifts
    // mid-session.
    this.deviceId = getOrCreateDeviceId()
    this.joinAccountBus()

    // Look up postage stamp. When switching identities, the new identity may
    // not have a stamp at all — explicitly clear any prior stamper state so
    // we don't emit a snapshot claiming `user-stamp` mode with the previous
    // identity's stamp.
    const stamp = this.lookupPostageStampForApp()
    if (stamp) {
      this.postageBatchId = stamp.batchID.toHex()
      this.signerKey = stamp.signerKey.toHex()
      await this.initializeStamper(stamp.depth)
    } else {
      this.postageBatchId = undefined
      this.signerKey = undefined
      this.stamper = undefined
      this.stamperAccountFingerprint = undefined
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

      if (message.data.account) {
        // Full synced projection received — hydrate a first-class writer view
        // (stamps incl. signer keys, derivationKey) instead of download-only.
        await this.hydratePartitionAccount(
          message.data.account,
          message.data.secret,
          message.data.networkSettings,
        )
      } else {
        // Legacy secret-only payload — download-only mode, no stamp lookup.
        this.postageBatchId = undefined
        this.signerKey = undefined
      }

      this.showAuthButton()
      this.sendToParent({
        type: "authSuccess",
        origin: this.parentOrigin!,
      })
      this.emitConnectionInfoIfChanged()
    }
  }

  /**
   * Build the in-memory account view for a partitioned session and initialize
   * the write path from it. The vault fields are inert placeholders — the
   * record never touches storage and the seed never leaves first-party
   * context; `SignedInAccount` merely requires their presence.
   */
  private async hydratePartitionAccount(
    account: SyncedAccount,
    appSecret: string,
    networkSettings: NetworkSettings | undefined,
  ): Promise<void> {
    const now = Date.now()
    const connection: ConnectedApp = {
      ...(account.connectedApps.find(
        (app) => app.appUrl === this.parentOrigin,
      ) ?? {
        appUrl: this.parentOrigin!,
        appName: this.appMetadata?.name ?? this.parentOrigin!,
        lastConnectedAt: now,
      }),
      appSecret,
      lastConnectedAt: now,
      connectedUntil:
        now +
        (account.settings?.appSessionDuration ?? DEFAULT_SESSION_DURATION),
    }
    this.partitionAccount = {
      ...account,
      connectedApps: [
        connection,
        ...account.connectedApps.filter(
          (app) => app.appUrl !== this.parentOrigin,
        ),
      ],
      access: { type: "password", kdfSalt: "", kdfIterations: 0 },
      encryptedSeed: "",
    }

    this.applyNetworkSettingsValues(networkSettings)

    await this.refreshStampFromStorage()
  }

  /**
   * Join the account bus for whatever connection is resolvable right now
   * (idempotent per account). Called from every path that establishes or
   * re-resolves a connection — the unpartitioned ones included, or the bus
   * would never reach past this origin+partition outside Safari.
   */
  private joinAccountBus(): void {
    const connection = this.findConnectionForParent()
    if (!connection) return
    const { derivationKey } = connection.account
    const accountId = connection.account.id.toHex()
    // Already joined for this account, with everything it wanted attached.
    // This runs on every accounts storage event, so returning here (rather
    // than after the derivation) saves two HMACs and an `importKey` per event
    // — and avoids bumping `busJoinGeneration`, which retires a join still in
    // flight. A join left incomplete (a transport that threw) does not latch
    // the key, so it retries here instead.
    if (derivationKey === this.busJoinedKey) return
    void this.ensureAccountBusTransports(derivationKey, accountId)
  }

  /**
   * Attach the account's bus transports (docs/Account-Bus.md). Idempotent per
   * account; same code path on every browser — Safari is not special.
   *
   * BOTH transports hang off the account-derived topic, so a context only ever
   * shares a channel with other contexts of the same account. The local one is
   * attached whether or not a signaling URL is configured: without it there is
   * still same-device tab↔tab traffic to carry, and a build with no bus server
   * (GitHub Pages, plain `pnpm dev`) must not lose cross-tab utilization.
   *
   * Because the topic is derived, both transports now attach a few ticks after
   * an auth event rather than at construction, so a peer publishing inside
   * that window loses that one message. Bounded by a single HMAC derivation,
   * and no worse than a tab that has not finished loading — which has no
   * listener either; durable counters reconcile on the next read. `busTopic`
   * is set exactly when the local transport goes live, so it is the signal to
   * wait on.
   *
   * The two attaches are INDEPENDENT. `SignalingTransport` connects in its
   * constructor, where `new URL` / `new WebSocket` throw synchronously on a
   * url that is set but unusable (`ws://` from an https page, a CSP that omits
   * the bus host, a typo) — and that must cost the signaling transport only.
   * Letting it take the local one down produces "no bus at all, for the whole
   * session", silently and indistinguishably from a healthy build with no
   * signaling url at all.
   */
  private async ensureAccountBusTransports(
    derivationKey: string,
    accountId: string,
  ): Promise<void> {
    const generation = ++this.busJoinGeneration
    let context: BusContext
    try {
      context = await deriveBusContext(derivationKey)
    } catch (error) {
      console.error("[Proxy] Failed to derive the account bus context:", error)
      // Fail safe, not fail wrong: we no longer know this session's room, so
      // the previous account's must not stay attached under it.
      if (generation === this.busJoinGeneration) this.detachBusTransports()
      return
    }
    // Superseded while the key derivation was in flight — by a later join
    // (another account) or by `clearAuthData`, which drops the removers
    // synchronously. Attaching now would put a socket in a room this session
    // no longer belongs to, and overwrite a remover that a live join owns.
    if (generation !== this.busJoinGeneration) return

    if (this.busTopic !== context.topic) {
      // Leave the old room BEFORE anything can throw. A switch that fails
      // otherwise leaves this session publishing the new account's traffic
      // into the previous account's channel — the leak the account-derived
      // topic closes, surviving in the error path.
      this.detachBusTransports()
      try {
        this.removeBusLocal = this.bus.addTransport(
          new BroadcastChannelTransport(context.topic),
        )
      } catch (error) {
        // `new BroadcastChannel` throws in a detaching document. Nothing to
        // unwind: the signaling transport is constructed below, so this order
        // never leaves a live socket with no handle to close it.
        console.error(
          "[Proxy] Failed to attach the local bus transport:",
          error,
        )
        return
      }
      this.busTopic = context.topic
    }
    // Reached only with the local transport live for `context.topic`, so this
    // is the account a publish now actually reaches — whether the room was just
    // switched or was already the right one.
    this.busBoundAccountId = accountId

    if (this.signalingUrl && !this.removeBusSignaling) {
      try {
        this.removeBusSignaling = this.bus.addTransport(
          new SignalingTransport({
            url: this.signalingUrl,
            topic: context.topic,
            encryptionKey: context.encryptionKey,
            createPeerConnection:
              typeof RTCPeerConnection !== "undefined"
                ? () => new RTCPeerConnection()
                : undefined,
          }),
        )
      } catch (error) {
        console.error(
          "[Proxy] Failed to attach the bus signaling transport:",
          error,
        )
        // Leaves `busJoinedKey` unset, so the next join retries it — against
        // a local transport that is already live and stays that way.
        return
      }
    }
    this.busJoinedKey = derivationKey
  }

  /** Leave the account's bus room: both transports detached and closed, and
   *  every latch cleared so the next join is a fresh one. */
  private detachBusTransports(): void {
    this.removeBusSignaling?.()
    this.removeBusSignaling = undefined
    this.removeBusLocal?.()
    this.removeBusLocal = undefined
    this.busTopic = undefined
    this.busJoinedKey = undefined
    this.busBoundAccountId = undefined
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
    this.teardownCoordinator()
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer)
      this.publishTimer = undefined
    }

    // Retire any join still deriving its key — its continuation would
    // otherwise attach a freshly-opened socket to the bus we are closing,
    // with no handle left to close it. (`AccountBus.addTransport` also
    // refuses once closed; this just avoids opening the socket at all.)
    this.busJoinGeneration += 1
    this.removeBusLocal = undefined
    this.removeBusSignaling = undefined
    this.busTopic = undefined
    this.busJoinedKey = undefined
    this.busBoundAccountId = undefined
    this.bus.close()
  }

  /**
   * Tear the write coordinator down, announcing the partition it held so
   * waiting peers wake now instead of sleeping out their poll interval
   * (docs/Account-Bus.md, bus-accelerated leases). The announcement races the
   * Swarm release it describes, which is harmless: the lock SOCs stay the
   * authority, so a peer woken too early just spends one extra read round.
   */
  private teardownCoordinator(): void {
    const partition = this.coordinator?.currentPartition
    const accountId = this.coordinatorAccountId
    // Scheduled answers describe a lease we are about to drop anyway.
    this.cancelPendingYields()
    this.coordinator?.teardown()
    this.coordinator = undefined
    this.coordinatorAccountId = undefined
    if (partition === undefined || !accountId || !this.deviceId) return
    this.bus.publish({
      type: "lease-released",
      accountId,
      partition,
      fromDeviceId: this.deviceId,
    })
  }

  private static laneKey(
    batchId: string,
    partition: number,
    partitionCount: number,
  ): string {
    return `${batchId}:${partition}/${partitionCount}`
  }

  /**
   * Hold a lane-scoped delta that arrived with no lane bound to compare it
   * against, merged into whatever that lane already has.
   */
  private bufferLaneUpdate(message: {
    batchId: string
    partition: number
    partitionCount: number
    buckets: Array<{ index: number; value: number }>
  }): void {
    const key = SwarmIdProxy.laneKey(
      message.batchId,
      message.partition,
      message.partitionCount,
    )
    const buckets =
      this.pendingLaneUpdates.get(key) ?? new Map<number, number>()
    for (const { index, value } of message.buckets) {
      const current = buckets.get(index)
      if (current === undefined || value > current) buckets.set(index, value)
    }
    this.pendingLaneUpdates.set(key, buckets)
  }

  /**
   * Fold the buffered delta for the lane we just bound in, then drop every
   * buffered lane — the ones we did not bind are another device's business.
   * Called on every lease acquire: on the cold path the counters are already
   * seeded from the durable partition-state feed, so this is a harmless
   * monotonic no-op; on the adopt fast path they are not, and this is the
   * whole point.
   */
  private applyPendingLaneUpdate(): void {
    const buffered = this.pendingLaneUpdates
    this.pendingLaneUpdates = new Map()
    const lane = this.stamper?.currentPartition
    if (!this.stamper || !this.postageBatchId || lane === undefined) return
    const buckets = buffered.get(
      SwarmIdProxy.laneKey(
        this.postageBatchId,
        lane,
        this.stamper.partitionCount,
      ),
    )
    if (!buckets) return
    this.stamper.applyUtilizationUpdate(
      [...buckets].map(([index, value]) => ({ index, value })),
    )
  }

  /**
   * Run this holder's answer to a peer's `lease-request`, announcing the
   * partition it gave up so the waiter (and holders further down the rank
   * order) hear about it.
   *
   * The `lease-claim` goes out FIRST. Releasing is two stamped Swarm writes
   * (`yieldIdleLease` → `lease.release()`), which is orders of magnitude
   * longer than a rank step, so announcing only on completion would reach the
   * other holders long after every one of them had begun releasing too — #576
   * with extra steps. A claim is cheap to send and is what the rank step
   * actually budgets for.
   */
  private answerLeaseRequest(accountId: string, requestId?: string): void {
    const coordinator = this.coordinator
    if (!coordinator) return
    if (requestId !== undefined) {
      // Once the rank timer fires its handle is gone from `pendingYields`, so
      // the answered-id memory is what keeps a round from being answered twice
      // from here on. The claim below goes out in this same tick, so nothing
      // can slip between the two — the guard is what keeps that true if a
      // caller ever gets here after an await.
      if (this.answeredRequests.has(requestId)) return
      this.markRequestAnswered(requestId)
      this.bus.publish({
        type: "lease-claim",
        accountId,
        fromDeviceId: this.requireDeviceId(),
        requestId,
      })
    }
    coordinator
      .yieldForPeer()
      .then((partition) => {
        if (partition === undefined) return
        this.bus.publish({
          type: "lease-released",
          accountId,
          partition,
          fromDeviceId: this.requireDeviceId(),
          requestId,
        })
      })
      .catch((error) => {
        console.error("[Proxy] Peer lease yield failed:", error)
      })
  }

  /**
   * How long this holder waits before answering `requestId`.
   *
   * A waiter needs exactly ONE slot, but the request names no partition, so
   * every idle holder used to release at once: with `partitionCount = 4` all
   * four dropped their lease, each then paid a cold acquire on its next
   * upload, and whoever lost the re-race got "Uploads are unavailable". The
   * waiter re-broadcasts every round, so it repeated.
   *
   * The request id gives every holder the same permutation of the partitions,
   * and each waits its own rank in it. Exactly one draws rank 0 and answers
   * immediately — so the ordinary one-holder handover is not slowed at all —
   * while the rest stand down as soon as they see its `lease-claim`. Only
   * holders that would presently yield take a rank at all (`canYieldForPeer`),
   * so a holder mid-burst does not sit at the front of the order and decline
   * in silence; the next eligible rank answers a step later, which still beats
   * waiting out a poll interval.
   */
  private yieldRankDelayMs(requestId: string): number {
    const coordinator = this.coordinator
    const partition = coordinator?.currentPartition
    const partitionCount = coordinator?.partitionCount ?? 1
    if (partition === undefined || partitionCount <= 1) return 0
    // The id is hex (schema-enforced), so the seed needs no hash function.
    const seed = Number.parseInt(
      requestId.slice(0, LEASE_REQUEST_ID_LENGTH),
      16,
    )
    // Unreachable behind the schema, and deliberately LAST rather than first
    // if it ever becomes reachable: a seed nobody can agree on must not put
    // every holder at the front of the order — that is the bug, not the guard.
    if (!Number.isFinite(seed)) {
      return (partitionCount - 1) * PEER_YIELD_RANK_STEP_MS
    }
    return ((seed + partition) % partitionCount) * PEER_YIELD_RANK_STEP_MS
  }

  /** Stop answering `requestId` — somebody else claimed it (or we just did).
   *  Remembered as well as cancelled, because the rank timer may already have
   *  fired: it hands off to `answerLeaseRequest`, which re-checks this. */
  private standDownFromRequest(requestId: string | undefined): void {
    if (requestId === undefined) return
    this.markRequestAnswered(requestId)
    const scheduled = this.pendingYields.get(requestId)
    if (scheduled === undefined) return
    clearTimeout(scheduled)
    this.pendingYields.delete(requestId)
  }

  private markRequestAnswered(requestId: string): void {
    this.answeredRequests.add(requestId)
    if (this.answeredRequests.size <= ANSWERED_REQUEST_MEMORY) return
    // Insertion-ordered: the oldest round is the one safest to forget.
    const oldest = this.answeredRequests.values().next().value
    if (oldest !== undefined) this.answeredRequests.delete(oldest)
  }

  /** Drop every scheduled answer — nothing they would release is ours now. */
  private cancelPendingYields(): void {
    for (const timer of this.pendingYields.values()) {
      clearTimeout(timer)
    }
    this.pendingYields.clear()
  }

  /**
   * Account-bus subscription: utilization deltas from other contexts, and the
   * lease fast path (docs/Account-Bus.md, bus-accelerated leases). The Swarm
   * lock-SOC protocol stays authoritative — these messages only shortcut its
   * timers.
   */
  private setupBusListeners(): void {
    this.bus.subscribe((message) => {
      switch (message.type) {
        case "utilization-updated": {
          // Same batch AND same slot lane. The counters are per-partition
          // (`slot = partitionCount + partition + partitionCount·j`), so a
          // delta from a peer holding a DIFFERENT partition of this batch —
          // which is every other device of the account — is not comparable:
          // folding it in would skip this lane past its own unused slots and
          // then publish that as the partition's durable resume counter.
          // An unbound stamper has no lane of its own, so only a legacy
          // single-partition delta can apply. Spelled out rather than leaning
          // on `currentPartition ?? 0` staying unreachable for multi-partition
          // stampers (`unbindPartition` also resets the count to 1) — that
          // coupling lives in another file and is exactly the assumption whose
          // last violation caused the resume-pointer skip described above.
          if (message.batchId !== this.postageBatchId || !this.stamper) return
          const lane = this.stamper.currentPartition
          if (lane === undefined) {
            // Unbound: the lane this delta belongs to may well be the one we
            // are about to bind. Dropping it loses it for good — the adopt
            // fast path re-binds from THIS tab's in-memory counters
            // (`buildLeaseLocalCounter`), not from durable state, so a sibling
            // tab's writes would be invisible and we would re-issue slots it
            // already consumed. Hold it until the bind names our lane.
            // A legacy single-partition delta has no lease to wait for and
            // applies immediately.
            if (message.partition === 0 && message.partitionCount === 1) {
              this.stamper.applyUtilizationUpdate(message.buckets)
            } else {
              this.bufferLaneUpdate(message)
            }
            return
          }
          // Bound: same batch AND same slot lane. The counters are
          // per-partition (`slot = partitionCount + partition + partitionCount·j`),
          // so a delta from a peer holding a DIFFERENT partition of this batch
          // is not comparable: folding it in would skip this lane past its own
          // unused slots and then publish that as the partition's durable
          // resume counter.
          if (
            message.partition === lane &&
            message.partitionCount === this.stamper.partitionCount
          ) {
            // Apply delta update directly - no IndexedDB read needed
            this.stamper.applyUtilizationUpdate(message.buckets)
          }
          return
        }
        case "lease-request": {
          const coordinator = this.coordinator
          if (
            !coordinator ||
            message.accountId !== this.coordinatorAccountId ||
            message.fromDeviceId === this.deviceId
          ) {
            return
          }
          const { requestId } = message
          if (requestId === undefined) {
            // A peer on an older bundle: no rank order to join, so answer as
            // we always did rather than leaving it unserved.
            this.answerLeaseRequest(message.accountId)
            return
          }
          // Idempotent per request: the same message reaches us over every
          // attached transport, and the waiter re-broadcasts each round.
          if (this.pendingYields.has(requestId)) return
          if (this.answeredRequests.has(requestId)) return
          // Only holders that would actually yield take a rank. Otherwise a
          // holder mid-burst — with a 3 s idle threshold, the common case on
          // an active account — sits at the front of the order and declines in
          // silence, and every later rank falls through behind it.
          if (!coordinator.canYieldForPeer) return
          const timer = setTimeout(() => {
            this.pendingYields.delete(requestId)
            this.answerLeaseRequest(message.accountId, requestId)
          }, this.yieldRankDelayMs(requestId))
          this.pendingYields.set(requestId, timer)
          return
        }
        case "lease-claim": {
          if (
            message.fromDeviceId === this.deviceId ||
            message.accountId !== this.coordinatorAccountId
          ) {
            return
          }
          // A peer earlier in the rank order is answering this request — stand
          // down rather than dropping a second lease for one waiter. No slot is
          // free yet, so nothing wakes a waiting poll here.
          this.standDownFromRequest(message.requestId)
          return
        }
        case "lease-released": {
          if (
            message.fromDeviceId === this.deviceId ||
            message.accountId !== this.coordinatorAccountId
          ) {
            return
          }
          // The claim normally arrives first; this also covers a peer whose
          // claim we missed, and a release that answers no request at all.
          this.standDownFromRequest(message.requestId)
          this.coordinator?.notifySlotMaybeFree()
          return
        }
        case "account-delta": {
          this.applyAccountDelta(message.snapshot)
          return
        }
      }
    })
  }

  /**
   * Fold a peer's account snapshot into this session's view and reconcile.
   *
   * This is the only push channel a partitioned iframe has: it cannot see
   * shared storage, so without this a revoke reaches it only when the page
   * closes — and since #547 that session is a full writer holding every stamp's
   * signer key (docs/Account-Bus.md, `account-delta`).
   *
   * Durable truth is unchanged. An unpartitioned session still owns its state
   * through storage; the delta only drives the reconcile, and `clearAuthData`
   * invalidates the stored entry if the outcome is a disconnect.
   */
  private applyAccountDelta(snapshot: AccountStateSnapshot): void {
    // An EXPIRED session consumes deltas too, hence `includeEnded`. Nothing
    // expires a session live: `connectedUntil` is set once, at connect, and a
    // partitioned session's is hydrated from the popup — so a page open past
    // its deadline keeps uploading (`ensureCanUpload` reads the secret, not the
    // clock) while `findConnectionForParent` already reports nothing. Requiring
    // a VALID connection here would make the revoke that should end such a
    // session the one message it cannot hear. Folding into it is safe: the
    // reconcile below re-resolves under the normal rule, sees no valid
    // connection, and disconnects — where an expired session belongs anyway.
    const connection = this.findConnectionForParent({ includeEnded: true })
    // A delta for an account this origin is not connected to says nothing
    // about this session. (The topic is account-derived, so this is a
    // belt-and-braces check rather than the boundary.)
    if (!connection || snapshot.accountId !== connection.account.id.toHex()) {
      return
    }

    // Only a partitioned session folds. The hydrated view IS its state, and it
    // has no other way to learn this. An unpartitioned session's record is
    // shared storage, which this message did not write, so folding into memory
    // would only diverge the two — it reconciles from storage below instead.
    // (Which means a cross-device revoke does not yet reach an unpartitioned
    // session: that needs the UI to consume deltas and write them — #608.)
    const { account } = connection
    if (this.partitionAccount) {
      // The shared fold, not a second set of rules: `foldAccount` merges the
      // collections per `appUrl` / `batchID` on their tombstone clocks AND
      // every scalar on its own per-field clock, exactly as the Swarm read
      // path does. The metadata is not optional here — a moved default stamp
      // arrives as "old one tombstoned, new one added, pointer moved", so
      // folding the collections alone leaves the pointer on the tombstone,
      // `resolveStampForApp` resolves nothing, and the session cannot upload
      // for the page's life with the replacement key already in hand.
      // Local view first, so a tie on a collection entry keeps ours.
      const folded = foldAccount(
        [
          deltaFoldView(accountAsStateSnapshot(account)),
          deltaFoldView(snapshot),
        ],
        mergeDevicesList(account.devices, snapshot.metadata.devices),
      )
      this.partitionAccount = {
        ...this.partitionAccount,
        ...foldedToSyncedAccount({
          id: account.id,
          derivationKey: account.derivationKey,
          account: folded,
        }),
        connectedApps: restoreLocalSessionFields(
          folded.connectedApps,
          account.connectedApps,
        ),
      }
    }

    // On the reconcile queue, not beside it: this runs the same stamper rebind
    // a storage event does, and its rejections need the queue's catch.
    this.enqueueReconcile("applyAccountDelta", () =>
      this.reevaluateConnection("bus"),
    )
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
  private async initializeStamper(stampDepth: number): Promise<void> {
    if (!this.signerKey || !this.postageBatchId) {
      console.warn(
        "[Proxy] Cannot initialize stamper: missing signer key or batch ID",
      )
      return
    }

    // Look up account info for utilization tracking
    const accountInfo = await this.lookupAccountForApp()
    if (!accountInfo) {
      console.warn("[Proxy] Cannot initialize stamper: account not found")
      return
    }

    // Initialize utilization cache if not already done
    if (!this.utilizationStore) {
      this.utilizationStore = new UtilizationStoreDB()
    }

    // Create utilization-aware stamper with owner and encryption key
    try {
      this.stamper = await UtilizationAwareStamper.create(
        this.signerKey,
        new BatchId(this.postageBatchId),
        stampDepth,
        this.utilizationStore,
        accountInfo.owner,
        accountInfo.encryptionKey,
      )
      this.stamperAccountFingerprint = `${accountInfo.owner.toHex()}-${uint8ArrayToHex(accountInfo.encryptionKey)}`
    } catch (error) {
      console.error("[Proxy] Failed to create stamper:", error)
      this.stamper = undefined
      this.stamperAccountFingerprint = undefined
      return
    }

    // Build the write-path coordinator for this account+batch. It owns the
    // cross-tab write lock, the partition-lease lifecycle, and the stamp flush.
    // Lock-SOC routing on the stamper was auto-bound inside
    // `UtilizationAwareStamper.create`. For multi-device accounts the
    // coordinator eagerly pre-acquires a partition in the background
    // (`startLease`) so the first upload doesn't pay the acquire latency; a
    // concurrent first upload queues on the same write lock and then finds the
    // lease already held. Single-device accounts get a lock-only coordinator.
    this.teardownCoordinator()
    const backupKeyHex = await deriveSecret(
      uint8ArrayToHex(accountInfo.encryptionKey),
      "backup-key",
    )
    const tuning = readPartitionTuningOverride()
    this.coordinator = new BatchWriteCoordinator({
      bee: this.bee,
      batchId: this.postageBatchId,
      stamper: this.stamper,
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
      flushStamperState: () => this.saveStamperStateIfNeeded(),
      getWorkerPool: (count) => this.getOrCreateWorkerPool(count),
      onLeaseChange: () => this.emitConnectionInfoIfChanged(),
      // Each slot-wait poll round, ask live holders over the account bus to
      // yield their partition (docs/Account-Bus.md, bus-accelerated leases).
      // Fresh id per round: every holder derives the same rank order from it,
      // so exactly one answers (see `yieldRankDelayMs`), and a new round is a
      // new draw — a holder that was busy last time is not permanently first.
      onSlotWait: () =>
        this.bus.publish({
          type: "lease-request",
          accountId: accountInfo.accountId,
          fromDeviceId: this.requireDeviceId(),
          requestId: newLeaseRequestId(),
        }),
      // On first acquiring a partition, announce this device by publishing the
      // account snapshot (which includes ourselves in metadata.devices) to the
      // shared feed. Debounced + deferred so it runs OUTSIDE the acquiring write
      // lock (the publish re-enters the lock via the coordinator).
      //
      // Fold in any delta buffered while we had no lane FIRST, and
      // synchronously: the bind that just happened may have seeded the counters
      // from this tab's own in-memory state (the adopt fast path does), and the
      // publish below reads those counters.
      onLeaseAcquired: () => {
        this.applyPendingLaneUpdate()
        this.schedulePublish("acquired")
      },
    })
    this.coordinatorAccountId = accountInfo.accountId
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
   * Get or create a StampWorkerPool for parallel signing.
   * Lazy-initialized on first use and reused across uploads.
   * If requestedCount differs from the current pool size, the pool is recreated.
   */
  private async getOrCreateWorkerPool(
    requestedCount?: number,
  ): Promise<StampWorkerPool | undefined> {
    const desiredCount =
      requestedCount ??
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? Math.min(navigator.hardwareConcurrency, 8)
        : 4)

    if (this.stampWorkerPool && this.stampWorkerPool.size === desiredCount) {
      return this.stampWorkerPool
    }

    // Terminate old pool if count changed
    if (this.stampWorkerPool) {
      this.stampWorkerPool.terminate()
      this.stampWorkerPool = undefined
    }

    if (!this.signerKey || !this.stamper) return undefined

    try {
      this.stampWorkerPool = await StampWorkerPool.create(
        this.signerKey,
        this.stamper,
        desiredCount,
      )
      return this.stampWorkerPool
    } catch (error) {
      console.warn("[Proxy] Failed to create StampWorkerPool:", error)
      return undefined
    }
  }

  /**
   * Save stamper bucket state to IndexedDB
   * Utilization-aware stamper persists bucket state automatically
   */
  private async saveStamperState(): Promise<void> {
    if (!this.stamper) {
      return
    }

    try {
      // Capture bucket updates BEFORE flush clears dirtyBuckets — and the lane
      // they belong to in the same breath. Reading the lane after the await
      // instead lets a teardown landing mid-flush (`unbindPartition` resets the
      // partition to undefined and the count to 1) relabel partition-p counters
      // as the legacy `{0, 1}` lane, which every momentarily-unbound same-batch
      // peer then folds — the exact resume-pointer skip the lane guard exists
      // to prevent.
      const buckets = this.stamper.getBucketUpdatesForBroadcast()
      const partition = this.stamper.currentPartition ?? 0
      const partitionCount = this.stamper.partitionCount

      await this.stamper.flush()

      // Broadcast the utilization update to peers with pre-captured buckets.
      // Local transports only: the counters are per-partition, and every peer
      // a remote transport reaches is a different device holding a different
      // lane, so a remote copy is dropped at the receive guard after paying for
      // encryption and a frame the signaling server's payload cap may refuse
      // outright (one entry per dirty bucket, up to NUM_BUCKETS of them).
      if (this.postageBatchId && buckets.length > 0) {
        this.bus.publish(
          {
            type: "utilization-updated",
            batchId: this.postageBatchId,
            partition,
            partitionCount,
            buckets,
          },
          { localOnly: true },
        )
      }
    } catch (error) {
      console.error("[Proxy] Failed to save stamper state:", error)
    }
  }

  /**
   * Execute an upload operation against the right target for the current mode.
   * In subsidised mode (no usable user stamp) the gateway handles stamping, so
   * there is no local stamp state to protect and we run unlocked. In user-stamp
   * mode the write goes through the {@link BatchWriteCoordinator}, which takes
   * the cross-tab write lock, ensures a held partition, and flushes stamper
   * state — the proxy no longer owns any of that.
   */
  private async withModeAwareWriteLock<T>(
    targetOptions: { useWorkers?: boolean; workerCount?: number } | undefined,
    operation: (target: UploadTarget) => Promise<T>,
  ): Promise<T> {
    if (this.isSubsidisedModeActive()) {
      return operation({
        mode: "subsidised",
        gatewayUrl: this.subsidisedGatewayUrl!,
      })
    }
    if (!this.coordinator) {
      throw new Error("Stamper not initialized. Please login first.")
    }
    return this.coordinator.withWrite(operation, targetOptions)
  }

  /**
   * Save stamper state only in stamper mode.
   * In subsidised mode, there's no local stamp state to persist.
   */
  private async saveStamperStateIfNeeded(): Promise<void> {
    if (!this.isSubsidisedModeActive()) {
      await this.saveStamperState()
    }
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

      case "getPostageBatch":
        await this.handleGetPostageBatch(message, event)
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
      this.joinAccountBus()

      // Look up postage stamp from shared storage based on connected identity
      const stamp = this.lookupPostageStampForApp()
      if (stamp) {
        this.postageBatchId = stamp.batchID.toHex()
        this.signerKey = stamp.signerKey.toHex()
        await this.initializeStamper(stamp.depth)
      } else {
        this.postageBatchId = undefined
        this.signerKey = undefined
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
      const account =
        this.partitionAccount?.id.toHex() === accountId
          ? this.partitionAccount
          : createAccountsStorageManager()
              .load()
              .find((a) => a.id.toHex() === accountId)
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
      // A partitioned session cannot see shared storage — the hydrated account
      // view is both the source and the destination there. Without this branch
      // the load below returns nothing and the refresh silently no-ops, leaving
      // a Safari writer's rival set frozen at whatever the connect popup handed
      // over: the intent round never sees a peer that signs in later, and the
      // idle-yield (gated on a known rival) never fires. Mirrors the same
      // branch in `knownDeviceIdsForAccount`.
      const partitioned = this.partitionAccount?.id.toHex() === accountId
      const manager = partitioned ? undefined : createAccountsStorageManager()
      const accounts = manager?.load() ?? []
      const account = partitioned
        ? this.partitionAccount
        : accounts.find((a) => a.id.toHex() === accountId)
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
      // Persist when anything the rival set reads actually moved — a peer
      // appearing, a refreshed sign-in, a tombstone — not merely when the list
      // got longer, which discarded the timestamp-only merges `activeDeviceIds`
      // prunes on (#586). Our own heartbeat is excluded, so this still avoids
      // the cross-tab storage-event churn the length check was really for.
      if (
        deviceRegistryChanged(
          account.devices,
          mergedDevices,
          this.requireDeviceId(),
        )
      ) {
        if (partitioned) {
          // In-memory only, like the rest of the hydrated view: the stored
          // schema requires a vault, and the session re-handshakes per load.
          this.partitionAccount = { ...account, devices: mergedDevices }
        } else {
          manager!.save(
            accounts.map((a) =>
              a.id.toHex() === accountId ? { ...a, devices: mergedDevices } : a,
            ),
          )
        }
      }
    } catch (error) {
      console.warn(
        "[Proxy] Device-registry refresh failed (using current registry):",
        error,
      )
    }
  }

  /**
   * Assemble the current account-state snapshot for the connected app's
   * account. Needs no feed signing key, so it stays separate from
   * `buildAccountStateSnapshotForPublish` below — reusing that one would cost
   * two key derivations to send a bus message.
   *
   * `requireDefaultStamp` is the FEED path's precondition, not the snapshot's:
   * that write is paid for by the default stamp, while a bus message costs
   * nothing to send and `metadata.defaultPostageStampBatchID` is optional on
   * the wire. An account with no drives is a supported connected state, and
   * gating the delta on a stamp is how such an account's revokes never reach
   * its partitioned sessions at all.
   */
  private buildAccountStateSnapshot(options: {
    requireDefaultStamp: boolean
    includeEndedConnection: boolean
  }): AccountStateSnapshot | undefined {
    if (!this.parentOrigin || this.isDownloadOnlyPartition) return undefined
    const connection = this.findConnectionForParent({
      includeEnded: options.includeEndedConnection,
    })
    if (!connection) return undefined
    const { account } = connection

    if (options.requireDefaultStamp && !account.defaultPostageStampBatchID) {
      return undefined
    }

    return accountToStateSnapshot(account, account.id.toHex(), Date.now())
  }

  /**
   * Announce this session's account state to the account's other live contexts
   * (docs/Account-Bus.md, `account-delta`). Unlike the feed write below it
   * needs no partition and no lock — it is a message, not a write — so a
   * read-only session still relays what it can see to peers that cannot.
   *
   * `ofEndedConnection` reports a session that has just ENDED (the revoke a
   * storage event revealed), where the entry the snapshot is resolved from is
   * by definition no longer a valid connection.
   */
  private publishAccountDelta(options?: { ofEndedConnection: boolean }): void {
    const snapshot = this.buildAccountStateSnapshot({
      requireDefaultStamp: false,
      includeEndedConnection: options?.ofEndedConnection === true,
    })
    if (!snapshot) return
    // Same guard the feed write below carries, for the same reason and one
    // channel earlier: a debounced publish can fire mid account switch, after
    // the new account resolved but before `ensureAccountBusTransports` has
    // detached the old room — and these transports encrypt with the key they
    // were built with. Publishing then hands account B's snapshot, stamp signer
    // keys included, to account A's peers.
    if (
      this.busBoundAccountId !== undefined &&
      snapshot.accountId !== this.busBoundAccountId
    ) {
      console.warn(
        `[Proxy] Account changed since the bus room was joined (snapshot ${snapshot.accountId} vs bus room ${this.busBoundAccountId}); skipping delta.`,
      )
      return
    }
    this.bus.publish({
      type: "account-delta",
      snapshot: accountDeltaSnapshot(snapshot),
    })
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
    if (!this.parentOrigin || this.isDownloadOnlyPartition) {
      return undefined
    }
    try {
      const connection = this.findConnectionForParent()
      if (!connection) return undefined
      const snapshot = this.buildAccountStateSnapshot({
        requireDefaultStamp: true,
        includeEndedConnection: false,
      })
      if (!snapshot) return undefined

      const encryptionKey = await deriveSwarmEncryptionKey(
        connection.account.derivationKey,
      )
      const accountKey = new PrivateKey(
        await deriveSecret(encryptionKey, "backup-key"),
      )
      const owner = accountKey.publicKey().address()

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
   *
   * A coordinator is NOT a precondition — only the feed half of the publish
   * needs one, and `runAccountStatePublish` checks for it there, after the bus
   * delta has gone out.
   */
  private schedulePublish(reason: "acquired" | "change"): void {
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
   * Publish the account snapshot: to the account's live peers over the bus,
   * and to the shared feed via the coordinator (same write lock + held
   * partition). The feed write needs a partition; the bus message does not, so
   * it goes out first and a read-only session still relays to peers that
   * cannot see storage at all. Single-device accounts' feeds are published by
   * the SwarmID UI. Re-arms if a publish is already in flight so the latest
   * state still lands.
   */
  private async runAccountStatePublish(
    reason: "acquired" | "change",
  ): Promise<void> {
    // The in-flight guard runs before the delta publish below: a message needs
    // no lease, but a re-entrant call while a publish is in flight re-arms the
    // timer instead of sending the delta a second time for one change.
    if (this.publishInFlight) {
      this.schedulePublish(reason)
      return
    }
    if (reason === "change") this.publishAccountDelta()
    const coordinator = this.coordinator
    if (!coordinator || coordinator.currentPartition === undefined) return
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

      await coordinator.withWrite((target) =>
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
   * True while the session is partitioned WITHOUT a hydrated account view —
   * the legacy download-only mode. A hydrated partition is a full writer.
   */
  private get isDownloadOnlyPartition(): boolean {
    return this.storagePartitioned && !this.partitionAccount
  }

  /**
   * Find the account + connected-app pair for the current parent origin, reading
   * the nested account documents. Resolves ambiguity (the same app connected
   * under multiple accounts) by sorting valid entries by `lastConnectedAt`
   * descending and returning the most recent.
   */
  private findConnectionForParent(options?: {
    /**
     * Accept an entry whose session has ENDED — a lapsed `connectedUntil`, a
     * revoke tombstone, a hand disconnect. For CONSUMING authoritative news
     * about a session (`applyAccountDelta`) or REPORTING its end (the final
     * `account-delta`), never for serving work with it: such an entry must
     * still fail the reconcile that follows, or the session would never end.
     */
    includeEnded: boolean
  }): { account: SignedInAccount; app: ConnectedApp } | undefined {
    if (!this.parentOrigin) {
      return undefined
    }
    const usable = (app: ConnectedApp): boolean =>
      this.isConnectionValid(app) || options?.includeEnded === true
    // Partitioned session: shared storage is invisible; the popup-handed
    // account view is the (only) source.
    if (this.partitionAccount) {
      const app = this.partitionAccount.connectedApps.find(
        (candidate) =>
          candidate.appUrl === this.parentOrigin && usable(candidate),
      )
      return app ? { account: this.partitionAccount, app } : undefined
    }
    const accounts = createAccountsStorageManager().load()
    const matches: { account: SignedInAccount; app: ConnectedApp }[] = []
    for (const account of accounts) {
      // A signed-out account keeps no connected apps (and no derivationKey to
      // serve them with) — its record is just the vault remnant.
      if (isSignedOutAccount(account)) continue
      for (const app of account.connectedApps) {
        if (app.appUrl === this.parentOrigin && usable(app)) {
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

    // Clear stamper state from localStorage
    const stamperKey = `swarm-stamper-${this.parentOrigin}-${this.postageBatchId}`
    localStorage.removeItem(stamperKey)

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
    this.postageBatchId = undefined
    this.signerKey = undefined
    // Before dropping `deviceId` — the release announcement is sent as us.
    this.teardownCoordinator()
    this.deviceId = undefined
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer)
      this.publishTimer = undefined
    }
    this.stamper = undefined
    this.stamperAccountFingerprint = undefined
    this.pendingLaneUpdates.clear()
    this.storagePartitioned = false
    this.storagePartitionedIdentity = undefined
    this.partitionAccount = undefined
    this.detachBusTransports()
    // Retire any join still deriving its key, or it would re-attach behind us.
    this.busJoinGeneration += 1
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
    if (this.isDownloadOnlyPartition) {
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
      (!this.postageBatchId ||
        !this.signerKey ||
        this.isDownloadOnlyPartition) &&
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
      if (this.isDownloadOnlyPartition && this.storagePartitionedIdentity) {
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
        !this.isDownloadOnlyPartition
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
      // Read, not created: reporting it must not be what mints one, or the
      // "did this survive the reload" comparison would always say yes.
      deviceId: this.deviceId,
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
      deviceId: info.deviceId,
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
      await this.withModeAwareWriteLock(undefined, async (target) => {
        await uploadChunk(target, chunk.data, {
          pin: options?.pin,
          deferred: options?.deferred ?? false,
          tag: options?.tag,
          requestOptions,
        })
      })

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
    const { requestId, topic, signer, at, reference, encryptionKey, hints } =
      message

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

      // Use mode-aware write lock for the upload operation
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

  private async handleGetPostageBatch(
    message: GetPostageBatchMessage,
    event: MessageEvent,
  ): Promise<void> {
    const stamp = this.lookupPostageStampForApp()

    if (!stamp) {
      this.postMessage(event, {
        type: "getPostageBatchResponse",
        requestId: message.requestId,
        postageBatch: undefined,
      })
      return
    }

    // The stored stamp's `usable`/`exists` are a snapshot from assignment time
    // and can be stale (e.g. a batch assigned during its ~30s warm-up stays
    // `usable: false` in storage forever), so read live batch details from the
    // Bee node for those fields.
    const details = await fetchBatchDetails(
      this.beeApiUrl,
      stamp.batchID.toHex(),
    )

    // Resolve TTL from live chain state: the PostageStamp contract first
    // (ground truth for any batch, even one this Bee node has never seen), then
    // the Bee node's batchTTL. Fall back to the Swarmscan-price approximation
    // only when neither authoritative source can answer (e.g. RPC unreachable
    // and a public gateway that does not track the batch).
    let batchTTL: number | undefined = await fetchAuthoritativeBatchTTL(
      this.gnosisRpcUrl,
      this.beeApiUrl,
      stamp.batchID.toHex(),
      this.postageStampContractAddress,
    )
    if (batchTTL === undefined) {
      try {
        const pricePerGBPerMonth = await fetchSwarmPrice()
        batchTTL = calculateTTLSeconds(stamp.amount, pricePerGBPerMonth)
      } catch (error) {
        console.warn("[Proxy] Failed to calculate TTL:", error)
      }
    }

    // Map PostageStamp to public PostageBatch (exclude signerKey)
    const postageBatch: PostageBatch = {
      batchID: stamp.batchID.toHex(),
      utilization: stamp.utilization,
      usable: details?.usable ?? stamp.usable,
      label: "", // PostageStamp doesn't store label
      depth: stamp.depth,
      amount: stamp.amount.toString(),
      bucketDepth: stamp.bucketDepth,
      blockNumber: stamp.blockNumber,
      immutableFlag: stamp.immutableFlag,
      exists: details?.exists ?? stamp.exists,
      batchTTL,
    }

    this.postMessage(event, {
      type: "getPostageBatchResponse",
      requestId: message.requestId,
      postageBatch,
    })
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
  /**
   * Account-bus signaling server URL (e.g. `wss://swarm-id.snaha.net/bus`,
   * `ws://localhost:5520` in dev). Unset disables the cross-partition/
   * cross-device bus transport (docs/Account-Bus.md).
   */
  signalingUrl?: string
}

/**
 * Initialize the proxy (called from HTML page)
 */
export function initProxy(config?: ProxyConfig): SwarmIdProxy {
  return new SwarmIdProxy(config)
}
