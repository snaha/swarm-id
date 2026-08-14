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

import { Bee } from "@ethersphere/bee-js"

import { DEFAULT_BEE_NODE_URL } from "./schemas"
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

    new SwarmIdProxy()
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
})

const B1 = "aa".repeat(32)
const B2 = "bb".repeat(32)
const B3 = "cc".repeat(32)

const stampStub = (hex: string, deletedAt?: number) => ({
  batchID: { toHex: () => hex },
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

  it("returns an empty list when there is no connection", async () => {
    ;(proxy as never)["findConnectionForParent"] = () => undefined

    await getBatches()

    expect(lastMessage()).toMatchObject({
      type: "getPostageBatchesResponse",
      postageBatches: [],
    })
  })
})

describe("SwarmIdProxy upload stamp targeting (multi-stamp, doc §2)", () => {
  let proxy: SwarmIdProxy
  let bindStamp: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    proxy = makeProxy()
    bindStamp = vi.fn(() => Promise.resolve())
    ;(proxy as never)["bindStamp"] = bindStamp
    ;(proxy as never)["postageBatchId"] = B1
    ;(proxy as never)["findConnectionForParent"] = () => ({
      account: { postageStamps: [stampStub(B1), stampStub(B2)] },
    })
  })

  const ensure = (batchID?: string) =>
    (proxy as never)["ensureStampForUpload"](batchID)

  it("no-ops without a batchID", async () => {
    await ensure(undefined)
    expect(bindStamp).not.toHaveBeenCalled()
  })

  it("no-ops when the target is already bound", async () => {
    await ensure(B1)
    expect(bindStamp).not.toHaveBeenCalled()
  })

  it("re-binds to a different owned stamp", async () => {
    await ensure(B2)
    expect(bindStamp).toHaveBeenCalledTimes(1)
    expect(bindStamp.mock.calls[0][0].batchID.toHex()).toBe(B2)
  })

  it("rejects a batch the account does not own", async () => {
    await expect(ensure(B3)).rejects.toThrow("Batch not owned by account")
    expect(bindStamp).not.toHaveBeenCalled()
  })
})
