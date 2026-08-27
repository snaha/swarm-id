// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression: pressing Connect while `initialize()` was still running wedged
 * the demo until a page reload.
 *
 * `initialize()` guarded re-entry with `if (client || initializing) return`,
 * and `connect()` destroyed the client before re-initializing it for a changed
 * subsidised-gateway choice. A Connect that landed while the first run was
 * still in its tail — `getNodeInfo` → `checkAuthStatus`, two gateway
 * round-trips, so a 1-2s window against production — hit that guard and
 * silently bailed, and the run it had just pulled the client out from under
 * died on `Cannot read properties of undefined (reading 'checkAuthStatus')`.
 * What was left had no client, no iframe button, and a Connect button that did
 * nothing.
 *
 * The tests drive the same race deterministically by parking the tail on
 * `getNodeInfo` — where a real gateway round-trip parks it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SUBSIDISED_GATEWAY_STORAGE_KEY = 'swarm-id-demo-subsidised-gateway'

const hoisted = vi.hoisted(() => {
  const GATEWAY_URL = 'https://gateway.example'

  interface NodeInfo {
    beeMode: string
  }

  interface ClientOptions {
    subsidisedGatewayUrl?: string
  }

  function createGate<T>() {
    let resolveGate: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => {
      resolveGate = resolve
    })
    return { promise, release: (value: T) => resolveGate(value) }
  }

  // Set by tests that want the run to park mid-tail, or to fail outright.
  const control = { holdNodeInfo: false, initializeError: undefined as Error | undefined }

  const instances: FakeClient[] = []

  class FakeClient {
    readonly options: ClientOptions
    readonly nodeInfo = createGate<NodeInfo>()

    constructor(options: ClientOptions) {
      this.options = options
      instances.push(this)
    }

    initialize = vi.fn(async () => {
      if (control.initializeError) throw control.initializeError
      return undefined
    })
    makeSOCWriter = vi.fn(() => ({}))
    getNodeInfo = vi.fn(
      async (): Promise<NodeInfo> =>
        control.holdNodeInfo ? this.nodeInfo.promise : { beeMode: 'full' },
    )
    checkAuthStatus = vi.fn(async () => ({ authenticated: false, beeApiUrl: GATEWAY_URL }))
    connect = vi.fn(async () => undefined)
    disconnect = vi.fn(async () => undefined)
    destroy = vi.fn(() => undefined)
  }

  const storage = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
    },
  })
  // Seeded before the store module loads: `true` is the value that tells a
  // persisted choice apart from the built-in default, which is `false`.
  storage.set('swarm-id-demo-subsidised-gateway', 'true')

  return { GATEWAY_URL, FakeClient, instances, control, storage }
})

vi.mock('@snaha/swarm-id', () => ({
  SwarmIdClient: hoisted.FakeClient,
  DEFAULT_BEE_NODE_URL: hoisted.GATEWAY_URL,
  formatTTL: () => 'never',
}))

vi.mock('$lib/utils/environment', () => ({
  resolveProxyOrigin: () => 'https://id.example',
}))

import { clientStore } from './client.svelte'
import { logStore } from './log.svelte'

const { GATEWAY_URL, instances, control, storage } = hoisted

// Read at import time — the tests below change the preference.
const preferenceAtLoad = clientStore.subsidisedGatewayEnabled

function logsOfType(type: 'error' | 'warn') {
  return logStore.entries.filter((entry) => entry.type === type).map((entry) => entry.message)
}

function errorLogs() {
  return logsOfType('error')
}

/**
 * Start a run and hand back its promise once it is parked in the tail, where
 * the two gateway round-trips happen. Wrapped so awaiting the helper does not
 * also await the run it is handing over.
 */
async function initializeUpToTail(): Promise<{ settled: Promise<void> }> {
  control.holdNodeInfo = true
  const settled = clientStore.initialize()
  await vi.waitFor(() => expect(instances[0]?.getNodeInfo).toHaveBeenCalled())
  return { settled }
}

describe('clientStore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    clientStore.destroy()
    instances.length = 0
    control.holdNodeInfo = false
    control.initializeError = undefined
    logStore.clear()
    // Storage first, then the preference: the setter writes through, so
    // clearing afterwards would leave the store and storage disagreeing.
    storage.clear()
    clientStore.subsidisedGatewayEnabled = false
  })

  it('honours a connect that arrives while initialize() is still running', async () => {
    const { settled } = await initializeUpToTail()

    // The user ticks "use subsidised gateway" and presses Connect while the
    // first run is still waiting on the gateway.
    clientStore.subsidisedGatewayEnabled = true
    const connecting = clientStore.connect()
    control.holdNodeInfo = false

    instances[0].nodeInfo.release({ beeMode: 'full' })
    await settled
    await connecting

    // The connect waited for the run in flight to finish its tail instead of
    // pulling the client out from under it...
    expect(errorLogs()).toEqual([])
    expect(instances[0].checkAuthStatus).toHaveBeenCalledTimes(1)

    // ...and only then replaced the client, so the connect has one to run on.
    expect(instances).toHaveLength(2)
    expect(instances[0].destroy).toHaveBeenCalled()
    expect(instances[1].connect).toHaveBeenCalledTimes(1)
    expect(clientStore.client).toBeDefined()
    expect(clientStore.initializing).toBe(false)
  })

  it('stops an initialize() run whose client was destroyed under it', async () => {
    const { settled } = await initializeUpToTail()

    clientStore.destroy()
    instances[0].nodeInfo.release({ beeMode: 'full' })
    await settled

    // The tail stops at its next checkpoint instead of dereferencing the
    // client that destroy() just cleared.
    expect(errorLogs()).toEqual([])
    expect(instances[0].checkAuthStatus).not.toHaveBeenCalled()
    expect(clientStore.client).toBeUndefined()
    expect(clientStore.initializing).toBe(false)

    // ...and the store still comes back up afterwards.
    control.holdNodeInfo = false
    await clientStore.initialize()
    expect(instances).toHaveLength(2)
    expect(clientStore.client).toBeDefined()
  })

  it('drops a client whose initialize() failed, so the next run rebuilds', async () => {
    // A proxy origin that will not load rejects here, as does a version
    // mismatch that never signals readiness — both fast paths, and the store
    // used to keep the half-built client. `if (client)` then short-circuited
    // every later run, and a `SwarmIdClient` that failed cannot be reused
    // anyway: its `initialize()` throws "already initialized" on a second call.
    control.initializeError = new Error('Failed to load Swarm ID iframe')
    await clientStore.initialize()

    expect(errorLogs()).toEqual(['Initialization failed: Failed to load Swarm ID iframe'])
    expect(clientStore.client).toBeUndefined()
    expect(instances[0].destroy).toHaveBeenCalled()
    expect(clientStore.initializing).toBe(false)

    control.initializeError = undefined
    await clientStore.initialize()
    expect(instances).toHaveLength(2)
    expect(clientStore.client).toBeDefined()
  })

  it('refuses a connect that lands with no client instead of running it on a dead one', async () => {
    control.initializeError = new Error('Failed to load Swarm ID iframe')
    await clientStore.connect()

    expect(instances[0].checkAuthStatus).not.toHaveBeenCalled()
    expect(instances[0].connect).not.toHaveBeenCalled()
    expect(logsOfType('warn')).toContain('Connect ignored: the client is not initialized')
  })

  it('collapses two rapid Connect presses into one auth popup', async () => {
    // `SwarmIdClient.connect` opens the auth popup with `window.open`, so a
    // second press that ran its own connect would open a second popup. The
    // button is not disabled while the first press is in flight.
    const first = clientStore.connect()
    const second = clientStore.connect()
    await Promise.all([first, second])

    expect(instances).toHaveLength(1)
    expect(instances[0].connect).toHaveBeenCalledTimes(1)
    // Once for the initialize() tail, once for the single connect that ran.
    expect(instances[0].checkAuthStatus).toHaveBeenCalledTimes(2)
  })

  it('builds the client with the persisted subsidised-gateway choice', async () => {
    // `true` was seeded before the module loaded, so this is the stored choice
    // winning over the default rather than the default itself.
    expect(preferenceAtLoad).toBe(true)

    // `beforeEach` cleared storage and reset the choice, so this run builds
    // without the gateway.
    await clientStore.initialize()
    expect(instances[0].options.subsidisedGatewayUrl).toBeUndefined()

    clientStore.subsidisedGatewayEnabled = true
    expect(storage.get(SUBSIDISED_GATEWAY_STORAGE_KEY)).toBe('true')

    await clientStore.connect()
    expect(instances[1].options.subsidisedGatewayUrl).toBe(GATEWAY_URL)
  })
})
