// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SwarmIdClient,
  formatTTL,
  DEFAULT_BEE_NODE_URL,
  type Avatar,
  type ConnectionInfo,
  type PostageBatch,
} from '@snaha/swarm-id'
import { resolveProxyOrigin } from '$lib/utils/environment'
import { logStore } from './log.svelte'

const PROXY_PATH = '/proxy'
const CLIENT_TIMEOUT = 600000 // 10 minutes for large file uploads
const STAMP_USABLE_POLL_INTERVAL = 10000 // fresh batches become usable after ~30s
// Cap re-polling — on a public gateway the Bee node never learns about the
// batch, so the proxy keeps reporting the stored snapshot and the stamp
// would otherwise be polled forever.
const STAMP_USABLE_POLL_MAX_ATTEMPTS = 30

const BEE_ICON =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIHZpZXdCb3g9IjAgMCA1NiA1NiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIGZpbGw9IndoaXRlIiByeD0iOCIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LXNpemU9IjMyIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7wn5CdPC90ZXh0Pgo8L3N2Zz4='

interface IdentityInfo {
  id: string
  name: string
  address: string
  publicKey?: string
  avatar: Avatar
}

interface AppKeyInfo {
  address: string
  publicKey: string
}

interface StampInfo {
  batchID: string
  utilization: string
  usable: boolean
  depth: number
  bucketDepth: number
  amount: string
  blockNumber: number
  immutableFlag: boolean
  ttl: string
}

let client = $state<SwarmIdClient | undefined>(undefined)
let authenticated = $state(false)
let canUpload = $state(false)
let storagePartitioned = $state(false)
let uploadMode = $state<'user-stamp' | 'subsidised' | 'unavailable'>('unavailable')
let identity = $state<IdentityInfo | undefined>(undefined)
let appKey = $state<AppKeyInfo | undefined>(undefined)
let stamp = $state<StampInfo | undefined>(undefined)
// Every batch the account owns (a "drive" each) — drives the upload batch
// selector when there is more than one.
let batches = $state<PostageBatch[]>([])
// Batch id targeted by uploads; undefined = "Default" (the proxy resolves the
// per-app override / account default).
let selectedBatchId = $state<string | undefined>(undefined)
let partition = $state<number | undefined>(undefined)
let deferred = $state(false)
let initializing = $state(false)
let beeApiUrl = $state<string | undefined>(undefined)

let currentIdentityId: string | undefined
let currentIdentityName: string | undefined
let socWriterInstance: ReturnType<SwarmIdClient['makeSOCWriter']> | undefined
let currentSubsidisedGatewayUrl: string | undefined = undefined

// Monotonic generation counter for connection-change handler runs. Used to
// drop stale results from in-flight `getPostageBatches()` calls when the user
// switches identity or disconnects while a fetch is pending.
let connectionGeneration = 0

// Re-poll timer for a not-yet-usable stamp (see updatePostageStampInfo).
let stampPollTimer: ReturnType<typeof setTimeout> | undefined
let stampPollAttempts = 0

function clearStampPollTimer() {
  if (stampPollTimer !== undefined) {
    clearTimeout(stampPollTimer)
    stampPollTimer = undefined
  }
  stampPollAttempts = 0
}

function toStampInfo(batch: PostageBatch): StampInfo {
  return {
    batchID: String(batch.batchID),
    utilization: batch.utilization.toFixed(2),
    usable: batch.usable,
    depth: batch.depth,
    bucketDepth: batch.bucketDepth,
    amount: batch.amount,
    blockNumber: batch.blockNumber,
    immutableFlag: batch.immutableFlag,
    ttl: formatTTL(batch.batchTTL),
  }
}

async function updatePostageStampInfo(generation: number) {
  if (!client) return

  try {
    const fetched = await client.getPostageBatches()
    if (generation !== connectionGeneration) return
    batches = fetched
    // A selected batch that no longer exists (identity switch, deleted drive)
    // falls back to Default rather than silently failing every upload.
    if (
      selectedBatchId !== undefined &&
      !fetched.some((b) => String(b.batchID) === selectedBatchId)
    ) {
      selectedBatchId = undefined
    }
    // The demo shows one stamp; an account may own several ("drives") —
    // track the one untargeted uploads consume (the sidebar getter overlays
    // the upload-batch selection on top of this).
    // No `?? fetched[0]` fallback: with no default, presenting an arbitrary
    // drive as the active stamp is a lie — untargeted uploads go subsidised,
    // and the badge that says so would be suppressed.
    const batch = fetched.find((b) => b.isDefault)
    // A freshly bought batch reports usable=false until it warms up on chain
    // (~30s) — re-poll until it flips so the UI catches up without a reload.
    // Driven by the drive the sidebar actually RENDERS (the selection, else the
    // default): polling the default only would leave a freshly bought
    // non-default drive reading "Unusable" for as long as it stays selected.
    const shown = fetched.find((b) => String(b.batchID) === selectedBatchId) ?? batch
    if (shown?.usable === false && stampPollAttempts < STAMP_USABLE_POLL_MAX_ATTEMPTS) {
      stampPollAttempts++
      stampPollTimer = setTimeout(() => {
        stampPollTimer = undefined
        if (generation !== connectionGeneration) return
        void updatePostageStampInfo(generation)
      }, STAMP_USABLE_POLL_INTERVAL)
    } else if (shown?.usable !== false) {
      stampPollAttempts = 0
    }
    if (batch) {
      const batchIdStr = String(batch.batchID)
      const previous = stamp
      stamp = toStampInfo(batch)
      // Poll re-runs only log when something the user can see changed.
      if (previous === undefined || previous.batchID !== batchIdStr) {
        logStore.log(`Postage stamp loaded: ${batchIdStr.slice(0, 16)}...`)
      } else if (previous.usable !== batch.usable) {
        logStore.log(`Postage stamp is now ${batch.usable ? 'usable' : 'unusable'}`)
      }
    } else if (fetched.length === 0) {
      stamp = undefined
      selectedBatchId = undefined
      logStore.log('No postage stamp configured')
    } else {
      // Drives exist but none is the account default. `selectedBatchId` stays:
      // it names a batch that is still there, and a user-chosen upload target
      // must survive (the stale-selection cleanup above drops removed ones).
      stamp = undefined
      logStore.log('No default drive set; untargeted uploads use the gateway')
    }
  } catch (error) {
    if (generation !== connectionGeneration) return
    stamp = undefined
    logStore.log(
      `Failed to get postage stamp: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    )
  }
}

async function onConnectionChange(info: ConnectionInfo) {
  // Bump the generation so any in-flight `getPostageBatches` from the previous
  // snapshot (e.g. a different identity or pre-disconnect state) is dropped
  // when it resolves instead of overwriting current state.
  const generation = ++connectionGeneration
  clearStampPollTimer()
  const isAuthenticated = info.identity !== undefined
  authenticated = isAuthenticated
  canUpload = info.canUpload
  storagePartitioned = info.storagePartitioned ?? false
  uploadMode = info.uploadMode ?? 'unavailable'

  // The avatar is logged by source only — its data URL would swamp the line.
  const loggableIdentity = info.identity
    ? JSON.stringify({ ...info.identity, avatar: info.identity.avatar.source })
    : undefined
  logStore.log(`Connection info: canUpload=${info.canUpload}, identity=${loggableIdentity}`)
  partition = info.partition

  if (info.storagePartitioned) {
    logStore.log(
      'Read-only mode: browser storage partitioning limits this session to downloads only',
      'warn',
    )
  } else if (isAuthenticated && !info.canUpload) {
    logStore.log('Upload disabled: no postage stamp available', 'warn')
  }

  if (info.identity) {
    const { id, name, address, publicKey, avatar } = info.identity
    if (currentIdentityId && currentIdentityId !== id) {
      logStore.log(`Identity switched from "${currentIdentityName}" to "${name}"`)
    }
    currentIdentityId = id
    currentIdentityName = name
    identity = { id, name, address, publicKey, avatar }
  } else {
    if (currentIdentityId) {
      logStore.log(`Disconnected from identity "${currentIdentityName}"`)
      currentIdentityId = undefined
      currentIdentityName = undefined
    }
    identity = undefined
  }

  appKey = info.appKey

  if (isAuthenticated) {
    await updatePostageStampInfo(generation)
  } else {
    stamp = undefined
    batches = []
    selectedBatchId = undefined
  }
}

export const clientStore = {
  get client() {
    return client
  },
  get authenticated() {
    return authenticated
  },
  get canUpload() {
    return canUpload
  },
  get storagePartitioned() {
    return storagePartitioned
  },
  get uploadMode() {
    return uploadMode
  },
  get identity() {
    return identity
  },
  get appKey() {
    return appKey
  },
  get stamp() {
    // The sidebar follows the upload-batch selection: a selected batch shows
    // ITS properties; "Default" shows the resolved default stamp.
    const selected =
      selectedBatchId !== undefined
        ? batches.find((b) => String(b.batchID) === selectedBatchId)
        : undefined
    return selected ? toStampInfo(selected) : stamp
  },
  get batches() {
    return batches
  },
  get selectedBatchId() {
    return selectedBatchId
  },
  set selectedBatchId(value: string | undefined) {
    selectedBatchId = value
  },
  /** `UploadOptions.batchID` for upload calls: the selected batch, or
   *  undefined so the proxy resolves the default. */
  get uploadBatchID() {
    return selectedBatchId
  },
  get partition() {
    return partition
  },
  get deferred() {
    return deferred
  },
  set deferred(value: boolean) {
    deferred = value
  },
  get initializing() {
    return initializing
  },
  get socWriter() {
    return socWriterInstance
  },
  get beeApiUrl() {
    return beeApiUrl
  },
  get hasCustomBeeApiUrl() {
    return beeApiUrl !== undefined && beeApiUrl !== DEFAULT_BEE_NODE_URL
  },

  async initialize() {
    if (client || initializing) return
    initializing = true

    const proxyOrigin = resolveProxyOrigin()
    logStore.log('Initializing Swarm ID client...')
    logStore.log(`PROXY_ORIGIN: ${proxyOrigin}`)
    logStore.log(`PROXY_PATH: ${PROXY_PATH}`)
    logStore.log(`Full Proxy URL: ${proxyOrigin}${PROXY_PATH}`)
    logStore.log(`User Agent: ${navigator.userAgent}`)

    client = new SwarmIdClient({
      iframeOrigin: proxyOrigin,
      iframePath: PROXY_PATH,
      timeout: CLIENT_TIMEOUT,
      subsidisedGatewayUrl: currentSubsidisedGatewayUrl,
      onConnectionChange,
      metadata: {
        name: 'Swarm ID Demo',
        description: 'Demo application showcasing Swarm ID authentication and Bee API operations',
        icon: BEE_ICON,
      },
      buttonConfig: {
        connectText: 'Connect to Swarm',
        disconnectText: 'Disconnect',
        loadingText: 'Loading...',
        backgroundColor: '#667eea',
        color: 'white',
        borderRadius: '6px',
      },
      containerId: 'swarm-id-button',
    })

    try {
      logStore.log('Starting client initialization...')
      await client.initialize()
      socWriterInstance = client.makeSOCWriter()
      logStore.log('Client initialized successfully')

      try {
        const nodeInfo = await client.getNodeInfo()
        const isDevMode = nodeInfo.beeMode === 'dev'
        deferred = isDevMode
        logStore.log(`Bee mode: ${nodeInfo.beeMode}, deferred default: ${isDevMode}`)
      } catch (error) {
        logStore.log(
          `Could not determine beeMode, keeping default: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        )
      }

      logStore.log('Checking auth status...')
      const status = await client.checkAuthStatus()
      beeApiUrl = status.beeApiUrl
      logStore.log(`Auth status: ${status.authenticated ? 'authenticated' : 'not authenticated'}`)
      // Connection state (identity/stamp/canUpload) flows in via onConnectionChange.
    } catch (error) {
      logStore.log(
        `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    } finally {
      initializing = false
    }
  },

  async connect(options?: { useSubsidisedGateway?: boolean }) {
    const useSubsidised = options?.useSubsidisedGateway ?? true
    const subsidisedUrl = useSubsidised ? DEFAULT_BEE_NODE_URL : undefined

    // If subsidised gateway setting changed, reinitialize the client
    if (client && currentSubsidisedGatewayUrl !== subsidisedUrl) {
      logStore.log(
        `Subsidised gateway changed to ${useSubsidised ? 'enabled' : 'disabled'}, reinitializing client...`,
      )
      connectionGeneration++
      clearStampPollTimer()
      client.destroy()
      client = undefined
      currentSubsidisedGatewayUrl = subsidisedUrl
      await this.initialize()
    }

    if (!client) return
    const status = await client.checkAuthStatus()
    if (status.authenticated) {
      await client.disconnect()
    } else {
      await client.connect()
    }
  },

  destroy() {
    // Bump the generation so an in-flight `getPostageBatches` resolving after
    // destroy can't write `stamp` back, and stop any pending re-poll.
    connectionGeneration++
    clearStampPollTimer()
    client?.destroy()
    client = undefined
    authenticated = false
    canUpload = false
    storagePartitioned = false
    uploadMode = 'unavailable'
    identity = undefined
    appKey = undefined
    stamp = undefined
    batches = []
    selectedBatchId = undefined
    partition = undefined
    socWriterInstance = undefined
  },
}
