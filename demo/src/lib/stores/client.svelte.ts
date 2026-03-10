import { SwarmIdClient, formatTTL } from '@swarm-id/lib'
import { resolveProxyOrigin } from '$lib/utils/environment'
import { logStore } from './log.svelte'

const PROXY_PATH = '/proxy'
const STORAGE_VERIFIED_KEY = 'swarm-demo-storage-verified'
const CLIENT_TIMEOUT = 60000

const BEE_ICON =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIHZpZXdCb3g9IjAgMCA1NiA1NiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIGZpbGw9IndoaXRlIiByeD0iOCIvPgogIDx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LXNpemU9IjMyIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj7wn5CdPC90ZXh0Pgo8L3N2Zz4='

interface IdentityInfo {
  id: string
  name: string
  address: string
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
let identity = $state<IdentityInfo | undefined>(undefined)
let stamp = $state<StampInfo | undefined>(undefined)
let storageVerified = $state(false)
let deferred = $state(false)
let initializing = $state(false)

let currentIdentityId: string | undefined
let currentIdentityName: string | undefined
let socWriterInstance: ReturnType<SwarmIdClient['makeSOCWriter']> | undefined

async function updatePostageStampInfo() {
  if (!client) return

  try {
    const batch = await client.getPostageBatch()
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
    stamp = undefined
    logStore.log(
      `Failed to get postage stamp: ${error instanceof Error ? error.message : String(error)}`,
      'warn',
    )
  }
}

async function updateAuthStatus(isAuthenticated: boolean) {
  authenticated = isAuthenticated

  if (isAuthenticated) {
    storageVerified = true
    localStorage.setItem(STORAGE_VERIFIED_KEY, 'true')

    try {
      const connectionInfo = await client!.getConnectionInfo()
      logStore.log(
        `Connection info: canUpload=${connectionInfo.canUpload}, identity=${JSON.stringify(connectionInfo.identity)}`,
      )
      canUpload = connectionInfo.canUpload
      if (!connectionInfo.canUpload) {
        logStore.log('Upload disabled: no postage stamp available', 'warn')
      }

      if (connectionInfo.identity) {
        const { id, name, address } = connectionInfo.identity
        if (currentIdentityId && currentIdentityId !== id) {
          logStore.log(`Identity switched from "${currentIdentityName}" to "${name}"`)
        }
        currentIdentityId = id
        currentIdentityName = name
        identity = { id, name, address }
      }
    } catch (error) {
      logStore.log(
        `Failed to get connection info: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      canUpload = false
    }

    await updatePostageStampInfo()
  } else {
    canUpload = false
    stamp = undefined

    if (currentIdentityId) {
      logStore.log(`Disconnected from identity "${currentIdentityName}"`)
      currentIdentityId = undefined
      currentIdentityName = undefined
    }
    identity = undefined
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
  get identity() {
    return identity
  },
  get stamp() {
    return stamp
  },
  get storageVerified() {
    return storageVerified
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

  async initialize() {
    if (client || initializing) return
    initializing = true

    const proxyOrigin = resolveProxyOrigin()
    storageVerified = localStorage.getItem(STORAGE_VERIFIED_KEY) === 'true'

    logStore.log('Initializing Swarm ID client...')
    logStore.log(`PROXY_ORIGIN: ${proxyOrigin}`)
    logStore.log(`PROXY_PATH: ${PROXY_PATH}`)
    logStore.log(`Full Proxy URL: ${proxyOrigin}${PROXY_PATH}`)
    logStore.log(`User Agent: ${navigator.userAgent}`)

    client = new SwarmIdClient({
      iframeOrigin: proxyOrigin,
      iframePath: PROXY_PATH,
      timeout: CLIENT_TIMEOUT,
      onAuthChange: async (auth: boolean) => {
        logStore.log(`Auth status changed: ${auth}`)
        await updateAuthStatus(auth)
      },
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
      logStore.log(`Auth status: ${status.authenticated ? 'authenticated' : 'not authenticated'}`)
      await updateAuthStatus(status.authenticated)
    } catch (error) {
      logStore.log(
        `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    } finally {
      initializing = false
    }
  },

  async connect(options?: { agent?: boolean }) {
    if (!client) return
    const status = await client.checkAuthStatus()
    if (status.authenticated) {
      await client.disconnect()
    } else {
      client.connect({ agent: options?.agent })
    }
  },

  destroy() {
    client?.destroy()
    client = undefined
    authenticated = false
    canUpload = false
    identity = undefined
    stamp = undefined
    socWriterInstance = undefined
  },
}
