// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

// Wrap the Bee constructor so tests can observe which node URL the proxy points
// its client at, without touching any other bee-js export the proxy relies on.
vi.mock("@ethersphere/bee-js", async (importActual) => {
  const actual = await importActual<typeof import("@ethersphere/bee-js")>()
  return {
    ...actual,
    Bee: vi.fn(function (url: string) {
      return new actual.Bee(url)
    }),
  }
})

// Stub the stamper/store/coordinator machinery so `initializeStamper` can run
// without IndexedDB or network access; the coordinator mock records its deps.
vi.mock("./utils/batch-utilization", async (importActual) => {
  const actual =
    await importActual<typeof import("./utils/batch-utilization")>()
  return {
    ...actual,
    UtilizationAwareStamper: {
      // Carries the batchId it was created for — the proxy's per-batch stamp
      // entries and the coordinator's per-write context key off it.
      create: vi.fn((_signerKey: string, batchId: unknown) =>
        Promise.resolve({ mock: "stamper", batchId }),
      ),
    },
  }
})
vi.mock("./storage/utilization-store", () => ({
  UtilizationStoreDB: vi.fn(function () {
    return {}
  }),
}))
vi.mock("./sync/batch-write-coordinator", () => ({
  BatchWriteCoordinator: vi.fn(function (deps: unknown) {
    return {
      deps,
      startLease: vi.fn(),
      teardown: vi.fn(),
      withWrite: vi.fn(),
      currentPartition: undefined,
    }
  }),
}))

import { Bee } from "@ethersphere/bee-js"

import { DEFAULT_BEE_NODE_URL } from "./schemas"
import { BatchWriteCoordinator } from "./sync/batch-write-coordinator"
import { UtilizationAwareStamper } from "./utils/batch-utilization"
import { SwarmIdProxy } from "./swarm-id-proxy"
import { deriveSecret, uint8ArrayToHex } from "./utils/key-derivation"
import { STORAGE_KEY_NETWORK_SETTINGS } from "./types"

const PARENT_ORIGIN = "https://dapp.example.com"
const ATTACKER_ORIGIN = "https://evil.example.com"

type MessageListener = (event: MessageEvent) => Promise<void>

describe("SwarmIdProxy parentIdentify security (#410)", () => {
  let parentWindow: { postMessage: ReturnType<typeof vi.fn> }
  let attackerWindow: { postMessage: ReturnType<typeof vi.fn> }
  let messageListener: MessageListener

  beforeEach(() => {
    vi.restoreAllMocks()

    parentWindow = { postMessage: vi.fn() }
    attackerWindow = { postMessage: vi.fn() }

    const listeners: Record<string, unknown> = {}
    const mockWindow = {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      parent: parentWindow,
      location: { origin: "https://id.example.com" },
    }
    vi.stubGlobal("window", mockWindow)

    new SwarmIdProxy()
    messageListener = listeners["message"] as MessageListener
  })

  const identifyMessage = (overrides: Record<string, unknown> = {}) => ({
    type: "parentIdentify",
    requestId: "r1",
    metadata: { name: "Test App" },
    ...overrides,
  })

  const dispatch = (data: unknown, origin: string, source: unknown) =>
    messageListener({ data, origin, source } as MessageEvent)

  const proxyReadyCalls = (win: { postMessage: ReturnType<typeof vi.fn> }) =>
    win.postMessage.mock.calls.filter(
      ([message]) => message?.type === "proxyReady",
    )

  it("rejects parentIdentify when event.source is not window.parent", async () => {
    await dispatch(identifyMessage(), ATTACKER_ORIGIN, attackerWindow)

    expect(proxyReadyCalls(attackerWindow)).toHaveLength(0)

    // Parent must not be bound: a follow-up message from the attacker is ignored
    await dispatch(
      { type: "checkAuth", requestId: "r2" },
      ATTACKER_ORIGIN,
      attackerWindow,
    )
    expect(attackerWindow.postMessage).not.toHaveBeenCalled()
  })

  it("does not let a non-parent window pre-bind before the real parent", async () => {
    await dispatch(
      identifyMessage({ subsidisedGatewayUrl: "https://evil-gateway.example" }),
      ATTACKER_ORIGIN,
      attackerWindow,
    )
    await dispatch(identifyMessage(), PARENT_ORIGIN, parentWindow)

    expect(attackerWindow.postMessage).not.toHaveBeenCalled()
    const ready = proxyReadyCalls(parentWindow)
    expect(ready).toHaveLength(1)
    expect(ready[0][0]).toMatchObject({
      type: "proxyReady",
      parentOrigin: PARENT_ORIGIN,
    })
  })

  it("rejects a schema-invalid parentIdentify from the real parent", async () => {
    // Missing required metadata
    await dispatch(
      { type: "parentIdentify", requestId: "r1" },
      PARENT_ORIGIN,
      parentWindow,
    )
    // Malformed subsidisedGatewayUrl
    await dispatch(
      identifyMessage({ subsidisedGatewayUrl: "not-a-url" }),
      PARENT_ORIGIN,
      parentWindow,
    )

    expect(proxyReadyCalls(parentWindow)).toHaveLength(0)
  })

  it("accepts a valid parentIdentify from window.parent", async () => {
    await dispatch(identifyMessage(), PARENT_ORIGIN, parentWindow)

    const ready = proxyReadyCalls(parentWindow)
    expect(ready).toHaveLength(1)
    expect(ready[0][0]).toMatchObject({
      type: "proxyReady",
      parentOrigin: PARENT_ORIGIN,
    })
  })
})

describe("SwarmIdProxy initialization failure (#420)", () => {
  let parentWindow: { postMessage: ReturnType<typeof vi.fn> }
  let messageListener: MessageListener
  let proxy: SwarmIdProxy

  beforeEach(() => {
    vi.restoreAllMocks()

    parentWindow = { postMessage: vi.fn() }

    const listeners: Record<string, unknown> = {}
    const mockWindow = {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      parent: parentWindow,
      location: { origin: "https://id.example.com" },
    }
    vi.stubGlobal("window", mockWindow)

    proxy = new SwarmIdProxy()
    messageListener = listeners["message"] as MessageListener
  })

  const messagesOfType = (type: string) =>
    parentWindow.postMessage.mock.calls.filter(
      ([message]) => message?.type === type,
    )

  it("sends initError to the parent when parentIdentify handling throws", async () => {
    vi.spyOn(proxy as never, "loadAuthData").mockRejectedValue(
      new Error("storage exploded"),
    )

    await messageListener({
      data: {
        type: "parentIdentify",
        requestId: "r1",
        metadata: { name: "Test App" },
      },
      origin: PARENT_ORIGIN,
      source: parentWindow,
    } as MessageEvent)

    expect(messagesOfType("proxyReady")).toHaveLength(0)
    const initErrors = messagesOfType("initError")
    expect(initErrors).toHaveLength(1)
    expect(initErrors[0][0]).toMatchObject({
      type: "initError",
      error: "storage exploded",
    })
  })
})

describe("SwarmIdProxy deriveAppSecret (#520)", () => {
  // 32-byte hex key — appSecret is raw private-key material in hex.
  const APP_SECRET_HEX = "11".repeat(32)
  let proxy: SwarmIdProxy
  let source: { postMessage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.restoreAllMocks()

    const listeners: Record<string, unknown> = {}
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://id.example.com" },
    })

    proxy = new SwarmIdProxy()
    source = { postMessage: vi.fn() }
  })

  const derive = (label: string) =>
    (proxy as never)["handleDeriveAppSecret"](
      { type: "deriveAppSecret", requestId: "r1", label },
      { source, origin: PARENT_ORIGIN } as unknown as MessageEvent,
    )

  const lastMessage = () =>
    source.postMessage.mock.calls[source.postMessage.mock.calls.length - 1][0]

  it("returns HMAC(appSecret, label) as bytes, stable and label-scoped", async () => {
    ;(proxy as never)["authenticated"] = true
    ;(proxy as never)["appSecret"] = APP_SECRET_HEX

    await derive("topic-seed")
    const first = lastMessage()
    expect(first).toMatchObject({
      type: "deriveAppSecretResponse",
      requestId: "r1",
    })
    expect(uint8ArrayToHex(first.secret)).toBe(
      await deriveSecret(APP_SECRET_HEX, "topic-seed"),
    )

    // Stable across calls (i.e. across sessions/devices for the same appSecret).
    await derive("topic-seed")
    expect(uint8ArrayToHex(lastMessage().secret)).toBe(
      uint8ArrayToHex(first.secret),
    )

    // A different label yields a different secret.
    await derive("other-label")
    expect(uint8ArrayToHex(lastMessage().secret)).not.toBe(
      uint8ArrayToHex(first.secret),
    )
  })

  it("errors when not authenticated instead of leaking a secret", async () => {
    await derive("topic-seed")
    expect(lastMessage()).toMatchObject({ type: "error", requestId: "r1" })
  })
})

describe("SwarmIdProxy honours a Bee URL change mid-session (#515)", () => {
  const NEW_BEE_URL = "https://custom-node.example.com/"
  let proxy: SwarmIdProxy
  let storageListeners: Array<(event: StorageEvent) => void>
  let store: Map<string, string>

  const BeeMock = vi.mocked(Bee)

  const setNetworkSettings = (beeNodeUrl: string) =>
    store.set(
      STORAGE_KEY_NETWORK_SETTINGS,
      JSON.stringify({ beeNodeUrl, gnosisRpcUrl: "https://rpc.example.com/" }),
    )

  const fireStorage = (key: string | undefined) =>
    storageListeners.forEach((listener) => listener({ key } as StorageEvent))

  beforeEach(() => {
    vi.restoreAllMocks()
    BeeMock.mockClear()

    store = new Map()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })

    storageListeners = []
    vi.stubGlobal("window", {
      addEventListener: (
        type: string,
        listener: (event: StorageEvent) => void,
      ) => {
        if (type === "storage") storageListeners.push(listener)
      },
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://id.example.com" },
    })

    proxy = new SwarmIdProxy()
  })

  it("rebuilds the Bee client at the newly configured node", () => {
    expect(BeeMock).toHaveBeenLastCalledWith(DEFAULT_BEE_NODE_URL)

    setNetworkSettings(NEW_BEE_URL)
    fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

    expect(BeeMock).toHaveBeenLastCalledWith(NEW_BEE_URL)
  })

  it("ignores storage events for other keys and unchanged URLs", () => {
    const callsAfterConstruction = BeeMock.mock.calls.length

    fireStorage("some-other-key")
    setNetworkSettings(DEFAULT_BEE_NODE_URL)
    fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

    expect(BeeMock.mock.calls.length).toBe(callsAfterConstruction)
  })

  it("rebuilds the stamper/coordinator and re-emits ConnectionInfo", async () => {
    const rebind = vi.fn(() => Promise.resolve())
    const emit = vi.fn()
    ;(proxy as never)["rebindActiveStamp"] = rebind
    ;(proxy as never)["emitConnectionInfoIfChanged"] = emit

    setNetworkSettings(NEW_BEE_URL)
    fireStorage(STORAGE_KEY_NETWORK_SETTINGS)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rebind).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

const B1 = "aa".repeat(32)
const B2 = "bb".repeat(32)
const B3 = "cc".repeat(32)

const stampStub = (hex: string, deletedAt?: number) => ({
  batchID: {
    toHex: () => hex,
    equals: (other: { toHex?: () => string }) => other?.toHex?.() === hex,
  },
  signerKey: { toHex: () => "11".repeat(32) },
  depth: 20,
  deletedAt,
})

const makeProxy = () => {
  const listeners: Record<string, unknown> = {}
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, listener: unknown) => {
      listeners[type] = listener
    }),
    removeEventListener: vi.fn(),
    parent: { postMessage: vi.fn() },
    location: { origin: "https://id.example.com" },
  })
  return new SwarmIdProxy()
}

describe("SwarmIdProxy getPostageBatches (multi-stamp, doc §2)", () => {
  let proxy: SwarmIdProxy
  let source: { postMessage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.restoreAllMocks()
    proxy = makeProxy()
    source = { postMessage: vi.fn() }
  })

  const getBatches = () =>
    (proxy as never)["handleGetPostageBatches"](
      { type: "getPostageBatches", requestId: "r1" },
      { source, origin: PARENT_ORIGIN } as unknown as MessageEvent,
    )

  const lastMessage = () =>
    source.postMessage.mock.calls[source.postMessage.mock.calls.length - 1][0]

  it("projects every non-deleted stamp and skips tombstones", async () => {
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: {
        postageStamps: [stampStub(B1), stampStub(B3, 123), stampStub(B2)],
      },
    })
    // Avoid the live Bee/RPC lookups — assert the fan-out, not the enrichment.
    ;(proxy as never)["stampToPostageBatch"] = (stamp: {
      batchID: { toHex: () => string }
    }) => Promise.resolve({ batchID: stamp.batchID.toHex() })

    await getBatches()

    expect(lastMessage()).toMatchObject({
      type: "getPostageBatchesResponse",
      requestId: "r1",
      postageBatches: [{ batchID: B1 }, { batchID: B2 }],
    })
  })

  it("marks the app's resolved default stamp with isDefault", async () => {
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: {
        defaultPostageStampBatchID: { toHex: () => B2 },
        postageStamps: [stampStub(B1), stampStub(B2)],
      },
    })
    ;(proxy as never)["stampToPostageBatch"] = (stamp: {
      batchID: { toHex: () => string }
    }) => Promise.resolve({ batchID: stamp.batchID.toHex() })

    await getBatches()

    expect(lastMessage()).toMatchObject({
      postageBatches: [
        { batchID: B1, isDefault: false },
        { batchID: B2, isDefault: true },
      ],
    })
  })

  it("returns an empty list when there is no connection", async () => {
    ;(proxy as never)["findConnectionForParent"] = () => undefined

    await getBatches()

    expect(lastMessage()).toMatchObject({
      type: "getPostageBatchesResponse",
      postageBatches: [],
    })
  })

  it("flags a PROMOTED binding as the default when no default pointer resolves", async () => {
    // The account's default pointer is gone, so `resolveStampForApp` finds
    // nothing — but a targeted write promoted B2 to the binding, and untargeted
    // uploads consume it. Reporting isDefault:false for every batch would make
    // the documented `find((b) => b.isDefault)` recipe come up empty while
    // uploads keep landing on B2.
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: { postageStamps: [stampStub(B1), stampStub(B2)] },
    })
    ;(proxy as never)["postageBatchId"] = B2
    ;(proxy as never)["stampToPostageBatch"] = (stamp: {
      batchID: { toHex: () => string }
    }) => Promise.resolve({ batchID: stamp.batchID.toHex() })

    await getBatches()

    expect(lastMessage()).toMatchObject({
      postageBatches: [
        { batchID: B1, isDefault: false },
        { batchID: B2, isDefault: true },
      ],
    })
  })
})

describe("SwarmIdProxy pruneStampEntries", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("leaves cached stampers alone when the connection can't be read", () => {
    const proxy = makeProxy()
    const terminate = vi.fn()
    const entries = new Map([
      [
        B1,
        { stamper: { tag: B1 }, signerKey: "k1", workerPool: { terminate } },
      ],
    ])
    ;(proxy as never)["stampEntries"] = entries
    // Transiently unreadable (mid-rewrite storage, expired session) — NOT
    // proof that the account owns nothing.
    ;(proxy as never)["findConnectionForParent"] = () => undefined
    ;(proxy as never)["pruneStampEntries"]()

    expect(entries.size).toBe(1)
    expect(terminate).not.toHaveBeenCalled()
  })

  it("defers a tombstoned batch's pool termination until its write lock frees", async () => {
    // Writes run OFF the work queue holding the batch's swarm-write-<id> lock
    // across write+flush; a storage event (drive deleted mid-upload) must not
    // terminate the pool under the in-flight signing — evict the entry now (no
    // future use) but terminate only once the batch lock frees.
    const proxy = makeProxy()
    const terminate = vi.fn()
    const entries = new Map([
      [
        B1,
        { stamper: { tag: B1 }, signerKey: "k1", workerPool: { terminate } },
      ],
    ])
    ;(proxy as never)["stampEntries"] = entries
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: { postageStamps: [stampStub(B1, 123)] },
    })
    let grantLock!: () => void
    vi.stubGlobal("navigator", {
      locks: {
        request: (_n: string, _o: unknown, cb: () => Promise<unknown>) =>
          new Promise((res) => {
            grantLock = () => res(cb())
          }),
      },
    })

    try {
      ;(proxy as never)["pruneStampEntries"]()

      // Entry gone immediately — no later targeted write can pick it up…
      expect(entries.size).toBe(0)
      // …but the pool survives while the (simulated) write holds the lock.
      expect(terminate).not.toHaveBeenCalled()

      grantLock()
      await new Promise((r) => setTimeout(r, 0))
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("still evicts a tombstoned batch when the connection reads fine", () => {
    const proxy = makeProxy()
    const terminate = vi.fn()
    const entries = new Map([
      [
        B1,
        { stamper: { tag: B1 }, signerKey: "k1", workerPool: { terminate } },
      ],
    ])
    ;(proxy as never)["stampEntries"] = entries
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: { postageStamps: [stampStub(B1, 123)] },
    })
    ;(proxy as never)["pruneStampEntries"]()

    expect(entries.size).toBe(0)
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})

describe("SwarmIdProxy stamp enrichment (getPostageBatches efficiency)", () => {
  let proxy: SwarmIdProxy
  let source: { postMessage: ReturnType<typeof vi.fn> }

  const fullStamp = (hex: string) => ({
    ...stampStub(hex),
    utilization: 0.5,
    usable: true,
    depth: 20,
    amount: "10000000000",
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: false,
    exists: true,
  })

  const getBatches = () =>
    (proxy as never)["handleGetPostageBatches"](
      { type: "getPostageBatches", requestId: "r1" },
      { source, origin: PARENT_ORIGIN } as unknown as MessageEvent,
    )

  const lastMessage = () =>
    source.postMessage.mock.calls[source.postMessage.mock.calls.length - 1][0]

  beforeEach(() => {
    vi.restoreAllMocks()
    proxy = makeProxy()
    source = { postMessage: vi.fn() }
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: { postageStamps: [fullStamp(B1), fullStamp(B2)] },
    })
  })

  it("fetches the Swarmscan price once for the whole request", async () => {
    let swarmscanCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        if (String(url).includes("swarmscan")) {
          swarmscanCalls++
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ pricePerGBPerMonth: 1 }),
          })
        }
        // Bee /stamps and the RPC are unreachable → price-fallback path.
        return Promise.resolve({ ok: false, status: 500 })
      }),
    )

    await getBatches()

    const { postageBatches } = lastMessage()
    expect(postageBatches).toHaveLength(2)
    expect(swarmscanCalls).toBe(1)
    for (const batch of postageBatches) {
      expect(batch.batchTTL).toBeGreaterThan(0)
    }
  })

  it("passes the stamp's drive name through as the batch label", async () => {
    ;(proxy as never)["findConnectionForParent"] = () => ({
      app: {},
      account: {
        postageStamps: [
          { ...fullStamp(B1), name: "Family photos" },
          fullStamp(B2),
        ],
      },
    })
    // All network sources down — the label comes from the stored stamp alone.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 500 })),
    )

    await getBatches()

    const { postageBatches } = lastMessage()
    expect(postageBatches[0].label).toBe("Family photos")
    // Unnamed stamps keep the documented "" fallback.
    expect(postageBatches[1].label).toBe("")
  })

  it("falls back to the stored snapshot when enrichment hangs", async () => {
    vi.useFakeTimers()
    try {
      // Every network source black-holes: the per-stamp timeout must fire and
      // the stored snapshot must be served instead of timing out the client.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      )

      const pending = getBatches()
      await vi.advanceTimersByTimeAsync(15_000)
      await pending

      const { postageBatches } = lastMessage()
      expect(postageBatches).toHaveLength(2)
      expect(postageBatches[0]).toMatchObject({
        batchID: B1,
        usable: true,
        exists: true,
      })
      expect(postageBatches[0].batchTTL).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("SwarmIdProxy upload stamp targeting (multi-stamp, doc §2)", () => {
  let proxy: SwarmIdProxy
  let bindStamp: ReturnType<typeof vi.fn>
  let refreshStampFromStorage: ReturnType<typeof vi.fn>
  const prevStamper = { tag: "stamper-b1" }

  beforeEach(() => {
    vi.restoreAllMocks()
    proxy = makeProxy()
    bindStamp = vi.fn((stamp: { batchID: { toHex: () => string } }) => {
      ;(proxy as never)["postageBatchId"] = stamp.batchID.toHex()
      ;(proxy as never)["stamper"] = { tag: stamp.batchID.toHex() }
      return Promise.resolve()
    })
    refreshStampFromStorage = vi.fn(() => Promise.resolve())
    ;(proxy as never)["bindStamp"] = bindStamp
    ;(proxy as never)["refreshStampFromStorage"] = refreshStampFromStorage
    ;(proxy as never)["postageBatchId"] = B1
    ;(proxy as never)["stamper"] = prevStamper
    ;(proxy as never)["coordinator"] = { withWrite: vi.fn() }
    ;(proxy as never)["utilizationStore"] = {}
    ;(proxy as never)["lookupAccountForApp"] = () =>
      Promise.resolve({
        owner: { toHex: () => "ab".repeat(20) },
        encryptionKey: new Uint8Array(32),
        accountId: "acct-1",
        partitionCount: 2,
      })
    ;(proxy as never)["findConnectionForParent"] = () => ({
      account: { postageStamps: [stampStub(B1), stampStub(B2)] },
    })
  })

  // `resolveUploadStamper` returns `{ stamper }` for a cached/default target
  // and a `pendingBuild` descriptor for one that needs building — the caller
  // (`withModeAwareWriteLock`) builds it off the work queue. `resolve` unwraps
  // the resolution alone; `resolveAndBuild` follows the descriptor through the
  // shared `buildAndCacheStamper`, mirroring the production caller.
  type Resolved = {
    stamper?: { tag?: string; batchId?: { toHex: () => string } }
    pendingBuild?: {
      stamp: unknown
      accountInfo: unknown
      store: unknown
    }
  }
  const resolve = async (batchID?: string) =>
    ((await (proxy as never)["resolveUploadStamper"](batchID)) as Resolved)
      .stamper
  const resolveAndBuild = async (batchID?: string) => {
    const picked = (await (proxy as never)["resolveUploadStamper"](
      batchID,
    )) as Resolved
    if (!picked.pendingBuild) return picked.stamper
    const { stamp, accountInfo, store } = picked.pendingBuild
    return (proxy as never)["buildAndCacheStamper"](
      stamp,
      accountInfo,
      store,
    ) as Promise<Resolved["stamper"]>
  }

  it("re-resolves the default binding when no batchID is given", async () => {
    const stamper = await resolve(undefined)
    expect(refreshStampFromStorage).toHaveBeenCalledTimes(1)
    expect(stamper).toBe(prevStamper)
    expect(bindStamp).not.toHaveBeenCalled()
  })

  it("returns the default stamper for the default batch id", async () => {
    const stamper = await resolve(B1)
    expect(stamper).toBe(prevStamper)
    expect(bindStamp).not.toHaveBeenCalled()
    expect(refreshStampFromStorage).not.toHaveBeenCalled()
  })

  it("builds and caches a targeted stamper with ONE coordinator, zero rebinds of the default", async () => {
    const stamper = await resolveAndBuild(B2)
    expect(stamper?.batchId?.toHex()).toBe(B2)
    // The default binding is untouched — no bindStamp, no coordinator churn.
    expect(bindStamp).not.toHaveBeenCalled()
    expect((proxy as never)["postageBatchId"]).toBe(B1)
    expect((proxy as never)["stamper"]).toBe(prevStamper)

    // Alternating B2 → B1 → B2 serves cached instances: the stamper is built
    // exactly once (the thrash the account-scoped lease removed).
    const again = await resolve(B1)
    expect(again).toBe(prevStamper)
    const cached = await resolve(B2)
    expect(cached).toBe(stamper)
    expect(vi.mocked(UtilizationAwareStamper.create)).toHaveBeenCalledTimes(1)
  })

  it("rejects a batch the account does not own", async () => {
    await expect(resolve(B3)).rejects.toThrow("Batch not owned by account")
    expect(bindStamp).not.toHaveBeenCalled()
  })

  it("builds a working stamper when the bound default batch's stamper failed to build", async () => {
    // Lenient `initializeStamper` can leave the batch id bound with NO
    // stamper. An upload explicitly targeting that batch must not resolve to
    // `undefined` (the caller would misroute it); the targeted build path
    // serves it instead, without touching the broken default binding.
    ;(proxy as never)["stamper"] = undefined

    const stamper = await resolveAndBuild(B1)

    expect(stamper?.batchId?.toHex()).toBe(B1)
    expect(bindStamp).not.toHaveBeenCalled()
    expect((proxy as never)["stamper"]).toBeUndefined()
  })

  it("a failed target build rejects the write and leaves the default binding untouched", async () => {
    vi.mocked(UtilizationAwareStamper.create).mockRejectedValueOnce(
      new Error("indexeddb exploded"),
    )
    await expect(
      (proxy as never as { withModeAwareWriteLock: Function })[
        "withModeAwareWriteLock"
      ](undefined, async (t: unknown) => t, B2),
    ).rejects.toThrow(`Failed to build stamper for batch ${B2}`)
    expect((proxy as never)["postageBatchId"]).toBe(B1)
    expect((proxy as never)["stamper"]).toBe(prevStamper)
  })

  it("promotes a targeted stamp to the default binding when none is bound", async () => {
    // No resolvable default (no coordinator): a targeted owned stamp must
    // still work — it becomes the lease binding, as the targeting PR did.
    ;(proxy as never)["coordinator"] = undefined
    ;(proxy as never)["postageBatchId"] = undefined
    ;(proxy as never)["stamper"] = undefined

    const stamper = await resolve(B2)
    expect(bindStamp).toHaveBeenCalledTimes(1)
    expect(bindStamp.mock.calls[0][0].batchID.toHex()).toBe(B2)
    expect(stamper).toEqual({ tag: B2 })
  })

  it("builds the stamper under the BATCH state lock, never the account lock", async () => {
    // `UtilizationAwareStamper.create` seeds bucket state from IndexedDB;
    // running it under the batch's `swarm-write-<batchId>` lock orders that
    // read after any SAME-BATCH write's flush (writes hold the batch lock
    // nested inside the account lock, across write + flush). Deliberately not
    // the account lock: that is held for the full duration of writes to
    // UNRELATED batches, so a build would park a rebind or a default-stamp
    // change behind a minutes-long upload to some other drive.
    const create = vi.mocked(UtilizationAwareStamper.create)
    const callsBefore = create.mock.calls.length
    let grantLock!: () => void
    const requested: string[] = []
    vi.stubGlobal("navigator", {
      locks: {
        request: (name: string, _opts: unknown, cb: () => Promise<unknown>) => {
          requested.push(name)
          return new Promise((resolveLock) => {
            grantLock = () => resolveLock(cb())
          })
        },
      },
    })
    try {
      const pending = resolveAndBuild(B2)
      await new Promise((r) => setTimeout(r, 0))
      expect(requested).toEqual([`swarm-write-${B2}`])
      expect(create.mock.calls.length).toBe(callsBefore)

      grantLock()
      const stamper = await pending
      expect(stamper?.batchId?.toHex()).toBe(B2)
      expect(create.mock.calls.length).toBe(callsBefore + 1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("never shares an in-flight build across different account inputs", async () => {
    // The built stamper bakes in the account's owner + encryption key. A
    // local→synced migration keeps the same batch and signer while changing
    // both, so an in-flight pre-migration build must not be handed to a
    // post-migration caller — that stamper would carry the OLD account's
    // encryption inputs.
    const create = vi.mocked(UtilizationAwareStamper.create)
    const callsBefore = create.mock.calls.length
    const build = (owner: string) =>
      (
        proxy as never as {
          createStamperUnderBatchLock: (
            accountInfo: unknown,
            signerKey: string,
            batchId: unknown,
            depth: number,
            store: unknown,
          ) => Promise<unknown>
        }
      )["createStamperUnderBatchLock"](
        {
          accountId: "acct-1",
          owner: { toHex: () => owner },
          encryptionKey: new Uint8Array(32),
        },
        "sig",
        { toHex: () => B2 },
        20,
        {},
      )

    const [a, b] = await Promise.all([
      build("aa".repeat(20)),
      build("bb".repeat(20)),
    ])

    expect(create.mock.calls.length).toBe(callsBefore + 2)
    expect(a).not.toBe(b)
  })

  it("shares one build between concurrent resolves of the same batch", async () => {
    // Builds now run off the serialized work queue, which used to guarantee
    // one at a time. Two live stampers for one batch would each carry their own
    // bucket state — exactly the divergence the account lock exists to prevent.
    const create = vi.mocked(UtilizationAwareStamper.create)
    const callsBefore = create.mock.calls.length

    const [a, b] = await Promise.all([resolveAndBuild(B2), resolveAndBuild(B2)])

    expect(a).toBe(b)
    expect(create.mock.calls.length).toBe(callsBefore + 1)
  })

  it("rebindActiveStamp re-binds the currently bound stamp", async () => {
    await (proxy as never)["rebindActiveStamp"]()
    expect(bindStamp).toHaveBeenCalledTimes(1)
    expect(bindStamp.mock.calls[0][0].batchID.toHex()).toBe(B1)
  })

  it("rebindActiveStamp no-ops when nothing is bound", async () => {
    ;(proxy as never)["postageBatchId"] = undefined
    await (proxy as never)["rebindActiveStamp"]()
    expect(bindStamp).not.toHaveBeenCalled()
  })
})

describe("SwarmIdProxy serialized stamped writes (PR #537 review)", () => {
  let proxy: SwarmIdProxy
  let withWrite: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    proxy = makeProxy()
    withWrite = vi.fn(
      (_stamper: unknown, operation: (t: unknown) => Promise<unknown>) =>
        operation({ mode: "stamper" }),
    )
    ;(proxy as never)["coordinator"] = { withWrite }
    ;(proxy as never)["resolveUploadStamper"] = vi.fn(() =>
      Promise.resolve({ stamper: { tag: "stamper" } }),
    )
  })

  const write = <T>(
    operation: (target: unknown) => Promise<T>,
    batchID?: string,
  ) =>
    (proxy as never)["withModeAwareWriteLock"](
      undefined,
      operation,
      batchID,
    ) as Promise<T>

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it("the work queue drains while a stamped write is in flight", async () => {
    // Only the RESOLUTION holds the queue; the (possibly minutes-long)
    // network op runs off it, so storage-event work — sign-out propagation,
    // stamp changes, node rebinds — is never head-of-line blocked behind an
    // upload.
    const events: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))

    const a = write(async () => {
      events.push("a-start")
      await gateA
      events.push("a-end")
    })
    await flush()
    expect(events).toEqual(["a-start"])

    // Queued while the write is still pending — must complete anyway.
    await (proxy as never)["enqueueWork"](async () => {
      events.push("queued-work")
    })
    expect(events).toEqual(["a-start", "queued-work"])

    releaseA()
    await a
    expect(events).toEqual(["a-start", "queued-work", "a-end"])
  })

  it("resolution stays serialized with queued rebinds", async () => {
    // A rebind already on the queue must finish BEFORE a later write picks
    // its stamper/coordinator — the atomic-with-rebinds half that stays.
    const events: string[] = []
    let releaseRebind!: () => void
    const gate = new Promise<void>((resolve) => (releaseRebind = resolve))
    void (proxy as never)["enqueueWork"](async () => {
      events.push("rebind-start")
      await gate
      events.push("rebind-end")
    })
    const resolveUploadStamper = (proxy as never)[
      "resolveUploadStamper"
    ] as ReturnType<typeof vi.fn>

    const a = write(async () => {
      events.push("op")
    })
    await flush()
    expect(resolveUploadStamper).not.toHaveBeenCalled()

    releaseRebind()
    await a
    expect(events).toEqual(["rebind-start", "rebind-end", "op"])
  })

  it("a failed write does not wedge the queue", async () => {
    await expect(
      write(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    await expect(write(async () => "ok")).resolves.toBe("ok")
  })

  it("subsidised writes without a batchID stay on the unqueued fast path", async () => {
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    ;(proxy as never)["postageBatchId"] = undefined
    ;(proxy as never)["signerKey"] = undefined

    const target = await write(async (t) => t)

    expect(target).toMatchObject({
      mode: "subsidised",
      gatewayUrl: "https://gateway.example/",
    })
    expect(withWrite).not.toHaveBeenCalled()
  })

  it("a targeted write while subsidised mode is active takes the stamped path with the target's stamper", async () => {
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    const targetStamper = { tag: B2 }
    const resolveUploadStamper = vi.fn(() =>
      Promise.resolve({ stamper: targetStamper }),
    )
    ;(proxy as never)["resolveUploadStamper"] = resolveUploadStamper

    const target = await write(async (t) => t, B2)

    // `deferBuild`: a target needing a NEW stamper comes back as a descriptor
    // so the build happens off the work queue, not while holding it.
    expect(resolveUploadStamper).toHaveBeenCalledWith(B2)
    expect(withWrite).toHaveBeenCalledTimes(1)
    // The write ran under the coordinator with the TARGET batch's stamper.
    expect(withWrite.mock.calls[0][0]).toBe(targetStamper)
    expect(target).toMatchObject({ mode: "stamper" })
  })

  it("an explicitly targeted write never falls back to the subsidised gateway", async () => {
    // Silently landing a `batchID`-targeted upload on the gateway would stamp
    // it under the GATEWAY's batch — betraying the requested target. Fail it.
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    ;(proxy as never)["resolveUploadStamper"] = vi.fn(() => Promise.resolve({}))

    await expect(write(async (t) => t, B2)).rejects.toThrow(
      "Stamper not initialized",
    )
    expect(withWrite).not.toHaveBeenCalled()
  })

  it("falls back to the gateway when the default binding resolves to nothing", async () => {
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    ;(proxy as never)["postageBatchId"] = undefined
    ;(proxy as never)["signerKey"] = undefined
    ;(proxy as never)["resolveUploadStamper"] = vi.fn(() => Promise.resolve({}))

    // A targeted id forces the queued path; the resolve returning nothing with
    // subsidised mode active degrades to the gateway instead of failing.
    const target = await write(async (t) => t)

    expect(target).toMatchObject({ mode: "subsidised" })
    expect(withWrite).not.toHaveBeenCalled()
  })
})

describe("SwarmIdProxy coordinator targets the configured Bee node", () => {
  const CoordinatorMock = vi.mocked(BatchWriteCoordinator)

  beforeEach(() => {
    vi.restoreAllMocks()
    CoordinatorMock.mockClear()
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })

  it("builds the coordinator against beeApiUrl even when the subsidised gateway is active", async () => {
    const proxy = makeProxy()
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    ;(proxy as never)["bee"] = { url: "https://gateway.example/" }
    ;(proxy as never)["signerKey"] = "11".repeat(32)
    ;(proxy as never)["postageBatchId"] = B1
    ;(proxy as never)["deviceId"] = "device-1"
    ;(proxy as never)["lookupAccountForApp"] = () =>
      Promise.resolve({
        owner: { toHex: () => "ab".repeat(20) },
        encryptionKey: new Uint8Array(32),
        accountId: "acct-1",
        partitionCount: 1,
      })

    await (proxy as never)["initializeStamper"](17)

    expect(CoordinatorMock).toHaveBeenCalledTimes(1)
    const deps = CoordinatorMock.mock.calls[0][0] as unknown as { bee: Bee }
    expect(String(deps.bee.url)).toContain(new URL(DEFAULT_BEE_NODE_URL).host)
    expect(String(deps.bee.url)).not.toContain("gateway.example")
  })

  it("reuses the cached stamper on re-init, so a node change never waits on the lock", async () => {
    // A stamper captures no node URL — only the coordinator does — so a
    // Bee-node change has nothing to rebuild. Rebuilding is not free: it parks
    // on the account write lock, which a long upload holds for its whole
    // duration, and it would terminate the batch's worker pool for nothing.
    const proxy = makeProxy()
    const create = vi.mocked(UtilizationAwareStamper.create)
    const signerKey = "11".repeat(32)
    const cachedStamper = { mock: "cached", batchId: { toHex: () => B1 } }
    ;(proxy as never)["signerKey"] = signerKey
    ;(proxy as never)["postageBatchId"] = B1
    ;(proxy as never)["deviceId"] = "device-1"
    ;(proxy as never)["stampEntries"] = new Map([
      [B1, { stamper: cachedStamper, signerKey }],
    ])
    ;(proxy as never)["lookupAccountForApp"] = () =>
      Promise.resolve({
        owner: { toHex: () => "ab".repeat(20) },
        encryptionKey: new Uint8Array(32),
        accountId: "acct-1",
        partitionCount: 1,
      })
    // Any lock request would hang, proving the path never reaches one.
    vi.stubGlobal("navigator", {
      locks: { request: () => new Promise(() => {}) },
    })
    const callsBefore = create.mock.calls.length

    try {
      await (proxy as never)["initializeStamper"](20)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(create.mock.calls.length).toBe(callsBefore)
    expect((proxy as never)["stamper"]).toBe(cachedStamper)
    expect(CoordinatorMock).toHaveBeenCalledTimes(1)
  })
})

describe("SwarmIdProxy coordinator lifetime + flush (PR #537 review)", () => {
  const CoordinatorMock = vi.mocked(BatchWriteCoordinator)

  beforeEach(() => {
    vi.restoreAllMocks()
    CoordinatorMock.mockClear()
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })

  it("tears the write coordinator down when the default binding is cleared", () => {
    const proxy = makeProxy()
    const teardown = vi.fn()
    ;(proxy as never)["coordinator"] = { teardown }
    ;(proxy as never)["postageBatchId"] = B1

    // e.g. the default drive was deleted in the trusted UI. A coordinator that
    // outlives the binding keeps heartbeating lease SOCs under the tombstoned
    // batch, and strands `resolveUploadStamper`'s promotion path.
    ;(proxy as never)["clearDefaultBinding"]()

    expect(teardown).toHaveBeenCalledTimes(1)
    expect((proxy as never)["coordinator"]).toBeUndefined()
  })

  it("tears the stale coordinator down when initializeStamper bails early", async () => {
    // bindStamp switches postageBatchId/signerKey and clears the stamper
    // BEFORE initializeStamper runs. Its early returns (no account readable)
    // must not leave the PREVIOUS batch's coordinator alive: it would keep
    // heartbeating lease SOCs under a batch this proxy no longer serves, and
    // `resolveUploadStamper`'s promotion path — gated on `!this.coordinator` —
    // would join that stale lease instead of rebinding.
    const proxy = makeProxy()
    const teardown = vi.fn()
    ;(proxy as never)["coordinator"] = { teardown }
    ;(proxy as never)["signerKey"] = "11".repeat(32)
    ;(proxy as never)["postageBatchId"] = B2
    ;(proxy as never)["lookupAccountForApp"] = () => Promise.resolve(undefined)

    await (proxy as never)["initializeStamper"](20)

    expect(teardown).toHaveBeenCalledTimes(1)
    expect((proxy as never)["coordinator"]).toBeUndefined()
  })

  it("flushes a stamped write's stamper even while subsidised mode reads active", async () => {
    const proxy = makeProxy()
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    ;(proxy as never)["signerKey"] = "11".repeat(32)
    ;(proxy as never)["postageBatchId"] = B1
    ;(proxy as never)["deviceId"] = "device-1"
    ;(proxy as never)["lookupAccountForApp"] = () =>
      Promise.resolve({
        owner: { toHex: () => "ab".repeat(20) },
        encryptionKey: new Uint8Array(32),
        accountId: "acct-1",
        partitionCount: 1,
      })

    await (proxy as never)["initializeStamper"](17)
    const deps = CoordinatorMock.mock.calls[0][0] as unknown as {
      flushStamperState: (s: unknown) => Promise<void>
    }

    // Default binding gone (deleted drive) + a configured gateway makes
    // `isSubsidisedModeActive()` true — but a targeted write still takes the
    // stamped path, so its bucket state MUST be persisted. Skipping it while
    // `setSyncedReference` keeps persisting leaves the next session with a
    // local counter below its synced reference.
    ;(proxy as never)["postageBatchId"] = undefined
    const stamper = {
      batchId: { toHex: () => B2 },
      getBucketUpdatesForBroadcast: vi.fn(() => []),
      flush: vi.fn(async () => {}),
    }

    await deps.flushStamperState(stamper)

    expect(stamper.flush).toHaveBeenCalledTimes(1)
  })
})
