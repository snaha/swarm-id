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

  const resolve = (batchID?: string) =>
    (proxy as never)["resolveUploadStamper"](batchID) as Promise<
      { tag?: string; batchId?: { toHex: () => string } } | undefined
    >

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
    const stamper = await resolve(B2)
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

  it("a failed target build rejects the write and leaves the default binding untouched", async () => {
    vi.mocked(UtilizationAwareStamper.create).mockRejectedValueOnce(
      new Error("indexeddb exploded"),
    )
    await expect(resolve(B2)).rejects.toThrow(
      `Failed to build stamper for batch ${B2}`,
    )
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
      Promise.resolve({ tag: "stamper" }),
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

  it("runs stamped writes strictly one after another", async () => {
    const events: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))

    const a = write(async () => {
      events.push("a-start")
      await gateA
      events.push("a-end")
    })
    const b = write(async () => {
      events.push("b-start")
    })

    await flush()
    expect(events).toEqual(["a-start"])

    releaseA()
    await Promise.all([a, b])
    expect(events).toEqual(["a-start", "a-end", "b-start"])
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
    const resolveUploadStamper = vi.fn(() => Promise.resolve(targetStamper))
    ;(proxy as never)["resolveUploadStamper"] = resolveUploadStamper

    const target = await write(async (t) => t, B2)

    expect(resolveUploadStamper).toHaveBeenCalledWith(B2)
    expect(withWrite).toHaveBeenCalledTimes(1)
    // The write ran under the coordinator with the TARGET batch's stamper.
    expect(withWrite.mock.calls[0][0]).toBe(targetStamper)
    expect(target).toMatchObject({ mode: "stamper" })
  })

  it("falls back to the gateway when the default binding resolves to nothing", async () => {
    ;(proxy as never)["subsidisedGatewayUrl"] = "https://gateway.example/"
    ;(proxy as never)["postageBatchId"] = undefined
    ;(proxy as never)["signerKey"] = undefined
    ;(proxy as never)["resolveUploadStamper"] = vi.fn(() =>
      Promise.resolve(undefined),
    )

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
})
