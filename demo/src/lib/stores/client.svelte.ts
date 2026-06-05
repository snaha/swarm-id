// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SwarmIdClient,
  formatTTL,
  DEFAULT_BEE_NODE_URL,
  type ConnectionInfo,
} from '@snaha/swarm-id'
import { resolveProxyOrigin } from '$lib/utils/environment'
import { logStore } from './log.svelte'

const PROXY_PATH = '/proxy'
const CLIENT_TIMEOUT = 600000 // 10 minutes for large file uploads

const BEE_ICON =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIHZpZXdCb3g9IjAgMCA1NiA1NiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIGZpbGw9IndoaXRlIiByeD0iOCIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LXNpemU9IjMyIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7wn5CdPC90ZXh0Pgo8L3N2Zz4='

interface IdentityInfo {
  id: string
  name: string
  address: string
  publicKey?: string
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
let partition = $state<number | undefined>(undefined)
let deferred = $state(false)
let initializing = $state(false)
let beeApiUrl = $state<string | undefined>(undefined)

let currentIdentityId: string | undefined
let currentIdentityName: string | undefined
let socWriterInstance: ReturnType<SwarmIdClient['makeSOCWriter']> | undefined
let currentSubsidisedGatewayUrl: string | undefined = undefined

// Monotonic generation counter for connection-change handler runs. Used to
// drop stale results from in-flight `getPostageBatch()` calls when the user
// switches identity or disconnects while a fetch is pending.
let connectionGeneration = 0

async function updatePostageStampInfo(generation: number) {
  if (!client) return

  try {
    const batch = await client.getPostageBatch()
    if (generation !== connectionGeneration) return
    if (batch) {
      const batchIdStr = String(batch.batchID)
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
      logStore.log(`Postage stamp loaded: ${batchIdStr.slice(0, 16)}...`)
    } else {
      stamp = undefined
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

async function onConnectionChange(info: ConnectionInfo) {
  // Bump the generation so any in-flight `getPostageBatch` from the previous
  // snapshot (e.g. a different identity or pre-disconnect state) is dropped
  // when it resolves instead of overwriting current state.
  const generation = ++connectionGeneration
  const isAuthenticated = info.identity !== undefined
  authenticated = isAuthenticated
  canUpload = info.canUpload
  storagePartitioned = info.storagePartitioned ?? false
  uploadMode = info.uploadMode ?? 'unavailable'

  logStore.log(
    `Connection info: canUpload=${info.canUpload}, identity=${JSON.stringify(info.identity)}`,
  )
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
    const { id, name, address, publicKey } = info.identity
    if (currentIdentityId && currentIdentityId !== id) {
      logStore.log(`Identity switched from "${currentIdentityName}" to "${name}"`)
    }
    currentIdentityId = id
    currentIdentityName = name
    identity = { id, name, address, publicKey }
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

  async connect(options?: { agent?: boolean; useSubsidisedGateway?: boolean }) {
    const useSubsidised = options?.useSubsidisedGateway ?? true
    const subsidisedUrl = useSubsidised ? DEFAULT_BEE_NODE_URL : undefined

    // If subsidised gateway setting changed, reinitialize the client
    if (client && currentSubsidisedGatewayUrl !== subsidisedUrl) {
      logStore.log(
        `Subsidised gateway changed to ${useSubsidised ? 'enabled' : 'disabled'}, reinitializing client...`,
      )
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
      await client.connect({ agent: options?.agent })
    }
  },

  destroy() {
    client?.destroy()
    client = undefined
    authenticated = false
    canUpload = false
    storagePartitioned = false
    uploadMode = 'unavailable'
    identity = undefined
    appKey = undefined
    stamp = undefined
    partition = undefined
    socWriterInstance = undefined
  },
}
