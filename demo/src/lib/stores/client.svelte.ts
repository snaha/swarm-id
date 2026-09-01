// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SwarmIdClient,
  formatTTL,
  DEFAULT_BEE_NODE_URL,
  type Avatar,
  type ConnectionInfo,
  type UploadUnavailableReason,
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

// The subsidised-gateway choice is persisted: the client is built once, on
// mount, so a reload that forgot the choice left an authenticated session
// reporting `canUpload=false` until the user disconnected and reconnected
// with the box re-ticked.
const SUBSIDISED_GATEWAY_STORAGE_KEY = 'swarm-id-demo-subsidised-gateway'
// The default the checkbox shipped with, kept deliberately. Subsidised uploads
// are stamped by the public gateway rather than by the user's own postage, so
// switching it on stays an explicit choice; persisting only changes how long
// that choice survives. (`connect()` did default the flag to on when a caller
// omitted it, but the sidebar never omitted it — it passed `false`.)
const SUBSIDISED_GATEWAY_DEFAULT = false

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
// Surfaced for the Safari check (#584): an id that CHANGES across loads means
// the partitioned storage holding it was evicted.
let deviceId = $state<string | undefined>(undefined)
let uploadMode = $state<'user-stamp' | 'subsidised' | 'unavailable'>('unavailable')
// Why uploads are off, when they are. Surfaced for the Safari check (#584):
// "no drive" and "the write path broke" look identical without it, and the
// first device run was read as the second when it was the first.
let uploadUnavailableReason = $state<UploadUnavailableReason | undefined>(undefined)
let identity = $state<IdentityInfo | undefined>(undefined)
let appKey = $state<AppKeyInfo | undefined>(undefined)
let stamp = $state<StampInfo | undefined>(undefined)
let partition = $state<number | undefined>(undefined)
let deferred = $state(false)
let initializing = $state(false)
let beeApiUrl = $state<string | undefined>(undefined)

function loadSubsidisedGatewayPreference(): boolean {
  try {
    const stored = localStorage.getItem(SUBSIDISED_GATEWAY_STORAGE_KEY)
    if (stored === 'true') return true
    if (stored === 'false') return false
  } catch {
    return SUBSIDISED_GATEWAY_DEFAULT
  }
  return SUBSIDISED_GATEWAY_DEFAULT
}

let subsidisedGatewayEnabled = $state(loadSubsidisedGatewayPreference())

let currentIdentityId: string | undefined
let currentIdentityName: string | undefined
let socWriterInstance: ReturnType<SwarmIdClient['makeSOCWriter']> | undefined
// The gateway the live client was built with — compared against the current
// preference to decide whether `connect()` has to rebuild it.
let currentSubsidisedGatewayUrl: string | undefined = undefined

// The `initialize()` run in flight, handed to every caller that arrives while
// it is still going, and the generation of the client it is setting up.
// `teardownClient()` bumps the generation so a run whose client was dropped
// mid-flight stops instead of dereferencing it.
let initializePromise: Promise<void> | undefined
let initializeGeneration = 0

// The `connect()` press in flight. `SwarmIdClient.connect` opens the auth popup
// with `window.open`, and the button is not disabled while a press is running,
// so a second press that ran on its own would open a second popup.
let connectPromise: Promise<void> | undefined

// Monotonic generation counter for connection-change handler runs. Used to
// drop stale results from in-flight `getPostageBatch()` calls when the user
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

async function updatePostageStampInfo(generation: number) {
  if (!client) return

  try {
    const batch = await client.getPostageBatch()
    if (generation !== connectionGeneration) return
    if (batch) {
      const batchIdStr = String(batch.batchID)
      const previous = stamp
      stamp = {
        batchID: batchIdStr,
        utilization: batch.utilization.toFixed(2),
        usable: batch.usable,
        depth: batch.depth,
        bucketDepth: batch.bucketDepth,
        amount: batch.amount,
        blockNumber: batch.blockNumber,
        immutableFlag: batch.immutableFlag,
        ttl: formatTTL(batch.batchTTL),
      }
      // Poll re-runs only log when something the user can see changed.
      if (previous === undefined || previous.batchID !== batchIdStr) {
        logStore.log(`Postage stamp loaded: ${batchIdStr.slice(0, 16)}...`)
      } else if (previous.usable !== batch.usable) {
        logStore.log(`Postage stamp is now ${batch.usable ? 'usable' : 'unusable'}`)
      }
      // A freshly bought batch reports usable=false until it warms up on
      // chain (~30s) — re-poll until it flips so the UI catches up without
      // a reload.
      if (batch.usable) {
        stampPollAttempts = 0
      } else if (stampPollAttempts < STAMP_USABLE_POLL_MAX_ATTEMPTS) {
        stampPollAttempts++
        stampPollTimer = setTimeout(() => {
          stampPollTimer = undefined
          if (generation !== connectionGeneration) return
          void updatePostageStampInfo(generation)
        }, STAMP_USABLE_POLL_INTERVAL)
      }
    } else {
      stamp = undefined
      stampPollAttempts = 0
      logStore.log('No postage stamp configured')
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

/** One line naming why uploads are off, for the log and the Safari report. */
function uploadUnavailableDescription(info: ConnectionInfo): string {
  switch (info.uploadUnavailableReason) {
    case 'no-stamp':
      return 'this account has no drive, so there is no postage stamp to upload with'
    case 'stamper-failed':
      return 'a postage stamp resolved but the write path would not build'
    default:
      return 'no postage stamp available'
  }
}

async function onConnectionChange(info: ConnectionInfo) {
  // Bump the generation so any in-flight `getPostageBatch` from the previous
  // snapshot (e.g. a different identity or pre-disconnect state) is dropped
  // when it resolves instead of overwriting current state.
  const generation = ++connectionGeneration
  clearStampPollTimer()
  const isAuthenticated = info.identity !== undefined
  authenticated = isAuthenticated
  canUpload = info.canUpload
  storagePartitioned = info.storagePartitioned ?? false
  deviceId = info.deviceId
  uploadMode = info.uploadMode ?? 'unavailable'
  uploadUnavailableReason = info.uploadUnavailableReason

  // The avatar is logged by source only — its data URL would swamp the line.
  const loggableIdentity = info.identity
    ? JSON.stringify({ ...info.identity, avatar: info.identity.avatar.source })
    : undefined
  logStore.log(`Connection info: canUpload=${info.canUpload}, identity=${loggableIdentity}`)
  partition = info.partition

  if (isAuthenticated && !info.canUpload) {
    // Say which of the three it is rather than guessing from `storagePartitioned`:
    // a partitioned session with no drive was being reported as a partitioning
    // problem, which sent the Safari investigation (#584) after the wrong thing.
    logStore.log(`Upload disabled: ${uploadUnavailableDescription(info)}`, 'warn')
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
  }
}

/**
 * Drop the live client and invalidate any `initialize()` run still in flight.
 *
 * That run's tail (`getNodeInfo` → `checkAuthStatus`) is two gateway
 * round-trips long, so it is routinely still going when the user presses
 * Connect. Bumping the generation makes it stop at its next checkpoint instead
 * of dereferencing the client this just cleared.
 */
function teardownClient() {
  connectionGeneration++
  initializeGeneration++
  initializePromise = undefined
  initializing = false
  clearStampPollTimer()
  client?.destroy()
  client = undefined
  socWriterInstance = undefined
  // Belonged to the client just dropped. Left behind, a custom node's URL
  // outlived it and kept the subsidised-gateway checkbox disabled.
  beeApiUrl = undefined
}

async function runInitialize(generation: number) {
  initializing = true

  try {
    const proxyOrigin = resolveProxyOrigin()
    logStore.log('Initializing Swarm ID client...')
    logStore.log(`PROXY_ORIGIN: ${proxyOrigin}`)
    logStore.log(`PROXY_PATH: ${PROXY_PATH}`)
    logStore.log(`Full Proxy URL: ${proxyOrigin}${PROXY_PATH}`)
    logStore.log(`User Agent: ${navigator.userAgent}`)

    currentSubsidisedGatewayUrl = subsidisedGatewayEnabled ? DEFAULT_BEE_NODE_URL : undefined

    // Held locally as well: everything below runs across awaits, and `client`
    // can be cleared under us by a teardown in between.
    const instance = new SwarmIdClient({
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
    client = instance

    logStore.log('Starting client initialization...')
    await instance.initialize()
    if (generation !== initializeGeneration) return
    socWriterInstance = instance.makeSOCWriter()
    logStore.log('Client initialized successfully')

    try {
      const nodeInfo = await instance.getNodeInfo()
      if (generation !== initializeGeneration) return
      const isDevMode = nodeInfo.beeMode === 'dev'
      deferred = isDevMode
      logStore.log(`Bee mode: ${nodeInfo.beeMode}, deferred default: ${isDevMode}`)
    } catch (error) {
      if (generation !== initializeGeneration) return
      logStore.log(
        `Could not determine beeMode, keeping default: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      )
    }

    logStore.log('Checking auth status...')
    const status = await instance.checkAuthStatus()
    if (generation !== initializeGeneration) return
    beeApiUrl = status.beeApiUrl
    logStore.log(`Auth status: ${status.authenticated ? 'authenticated' : 'not authenticated'}`)
    // Connection state (identity/stamp/canUpload) flows in via onConnectionChange.
  } catch (error) {
    if (generation !== initializeGeneration) return
    logStore.log(
      `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
    // Drop the half-built client rather than leaving it where `initialize()`
    // finds it: a `SwarmIdClient` that failed cannot be reused — its
    // `initialize()` throws "already initialized" — so keeping it made every
    // later run return early and every Connect run against a client that never
    // came up. Tearing down also rejects its pending init deferreds, clearing
    // the timers that would otherwise linger the full `CLIENT_TIMEOUT`.
    teardownClient()
  } finally {
    // A newer run owns the flag once this one has been superseded.
    if (generation === initializeGeneration) initializing = false
  }
}

/**
 * Bring the client up, or hand back the run that is already doing so.
 *
 * The run in flight wins over `client`: `runInitialize` publishes the client
 * before its awaits, so a caller that checked `client` first would sail past a
 * run that is still two round-trips from finished.
 */
function ensureInitialized(): Promise<void> {
  if (initializePromise) return initializePromise
  if (client) return Promise.resolve()

  const generation = ++initializeGeneration
  const pending = runInitialize(generation).finally(() => {
    // Only clear our own run: a teardown may already have replaced it.
    if (initializePromise === pending) initializePromise = undefined
  })
  initializePromise = pending
  return pending
}

async function runConnect(): Promise<void> {
  // Let a run that is already in flight finish first. Pressing Connect while
  // the initial `initialize()` was still in its tail used to drop the connect
  // (the old re-entrancy guard bailed out) and crash that tail on the client it
  // had just destroyed, leaving the demo dead until a page reload.
  await ensureInitialized()

  const subsidisedUrl = subsidisedGatewayEnabled ? DEFAULT_BEE_NODE_URL : undefined
  if (client && currentSubsidisedGatewayUrl !== subsidisedUrl) {
    logStore.log(
      `Subsidised gateway changed to ${subsidisedGatewayEnabled ? 'enabled' : 'disabled'}, reinitializing client...`,
    )
    teardownClient()
    await ensureInitialized()
  }

  const instance = client
  if (!instance) {
    // `initialize()` has already logged why.
    logStore.log('Connect ignored: the client is not initialized', 'warn')
    return
  }

  const status = await instance.checkAuthStatus()
  if (status.authenticated) {
    await instance.disconnect()
  } else {
    await instance.connect()
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
  get deviceId() {
    return deviceId
  },
  get uploadMode() {
    return uploadMode
  },
  get uploadUnavailableReason() {
    return uploadUnavailableReason
  },
  get identity() {
    return identity
  },
  get appKey() {
    return appKey
  },
  get stamp() {
    return stamp
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

  get subsidisedGatewayEnabled() {
    return subsidisedGatewayEnabled
  },
  set subsidisedGatewayEnabled(value: boolean) {
    subsidisedGatewayEnabled = value
    try {
      localStorage.setItem(SUBSIDISED_GATEWAY_STORAGE_KEY, String(value))
    } catch {
      logStore.log('Could not persist the subsidised gateway choice', 'warn')
    }
  },

  /**
   * Bring the client up, or hand back the run that is already doing so.
   *
   * Always await it. A caller that fires and forgets can tear the client down
   * under a run still in its tail, which is what used to wedge the store.
   */
  initialize(): Promise<void> {
    return ensureInitialized()
  },

  /**
   * Connect or disconnect, or hand back the press that is already doing so.
   *
   * Deduped for the same reason `initialize()` is: the Connect button stays
   * live while a press is running, and a second press reaching
   * `SwarmIdClient.connect` would open a second auth popup.
   */
  connect(): Promise<void> {
    if (connectPromise) return connectPromise

    const pending = runConnect().finally(() => {
      if (connectPromise === pending) connectPromise = undefined
    })
    connectPromise = pending
    return pending
  },

  destroy() {
    // Bumps the generations so an in-flight `getPostageBatch` resolving after
    // destroy can't write `stamp` back and an in-flight `initialize()` stops,
    // and stops any pending re-poll.
    teardownClient()
    authenticated = false
    canUpload = false
    storagePartitioned = false
    deviceId = undefined
    uploadMode = 'unavailable'
    identity = undefined
    appKey = undefined
    stamp = undefined
    partition = undefined
  },
}
