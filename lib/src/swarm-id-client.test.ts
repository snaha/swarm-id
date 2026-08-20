// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmIdClient } from "./swarm-id-client"
import { generatedAvatar } from "./utils/avatar"
import * as browser from "./utils/browser"

describe("SwarmIdClient connect()", () => {
  let client: SwarmIdClient

  beforeEach(() => {
    vi.restoreAllMocks()

    // Mock window object and its properties
    const mockWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn(),
    }

    vi.stubGlobal("window", mockWindow)
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue({
        style: {},
        onload: null,
        onerror: null,
        src: "",
        contentWindow: { postMessage: vi.fn() },
      }),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
    })

    client = new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: {
        name: "Test App",
        description: "A test application",
      },
    })
  })

  describe("non-WebKit (Chrome/Firefox)", () => {
    beforeEach(() => {
      vi.spyOn(browser, "isWebKit").mockReturnValue(false)
    })

    it("should open window directly with auth URL", async () => {
      vi.spyOn(client, "ensureReady").mockImplementation(() => {})

      await client.connect()

      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining("https://swarm-id.example.com/connect#origin="),
        "_blank",
      )
    })
  })

  describe("WebKit (Safari/iOS)", () => {
    beforeEach(() => {
      vi.spyOn(browser, "isWebKit").mockReturnValue(true)
    })

    it("should send connect message to proxy", async () => {
      vi.spyOn(client, "ensureReady").mockImplementation(() => {})
      const sendRequestSpy = vi
        .spyOn(client as never, "sendRequest")
        .mockResolvedValue({
          type: "connectResponse",
          requestId: "test",
          success: true,
        })

      await client.connect()

      expect(sendRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "connect",
        }),
      )
    })

    it("should throw when popup fails to open", async () => {
      vi.spyOn(client, "ensureReady").mockImplementation(() => {})
      vi.spyOn(client as never, "sendRequest").mockResolvedValue({
        type: "connectResponse",
        requestId: "test",
        success: false,
      })

      await expect(client.connect()).rejects.toThrow(
        "Failed to open authentication popup",
      )
    })
  })

  it("should throw error if client is not initialized", async () => {
    await expect(client.connect()).rejects.toThrow(
      "SwarmIdClient not initialized. Call initialize() first.",
    )
  })
})

describe("SwarmIdClient connectionInfo", () => {
  let client: SwarmIdClient
  let onConnectionChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn(),
    })
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue({
        style: {},
        onload: null,
        onerror: null,
        src: "",
        contentWindow: { postMessage: vi.fn() },
      }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    })

    onConnectionChange = vi.fn()
    client = new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: { name: "Test App", description: "A test application" },
      onConnectionChange,
    })
  })

  it("invokes onConnectionChange with the pushed snapshot and caches it", () => {
    const snapshot = {
      type: "connectionInfoChanged" as const,
      canUpload: true,
      storagePartitioned: undefined,
      uploadMode: "user-stamp" as const,
      identity: {
        id: "0x1111111111111111111111111111111111111111",
        name: "alice",
        address: "0x1111111111111111111111111111111111111111",
        publicKey: "0x02" + "ab".repeat(32),
        avatar: generatedAvatar("0x1111111111111111111111111111111111111111"),
      },
      appKey: {
        address: "0x2222222222222222222222222222222222222222",
        publicKey: "0x03" + "cd".repeat(32),
      },
    }

    ;(client as never)["handleIframeMessage"](snapshot)

    expect(onConnectionChange).toHaveBeenCalledTimes(1)
    expect(onConnectionChange).toHaveBeenCalledWith({
      canUpload: snapshot.canUpload,
      storagePartitioned: snapshot.storagePartitioned,
      uploadMode: snapshot.uploadMode,
      identity: snapshot.identity,
      appKey: snapshot.appKey,
    })

    // `connectionInfo` getter calls ensureReady — mark client as ready for the read
    ;(client as never)["ready"] = true
    expect(client.connectionInfo).toEqual({
      canUpload: snapshot.canUpload,
      storagePartitioned: snapshot.storagePartitioned,
      uploadMode: snapshot.uploadMode,
      identity: snapshot.identity,
      appKey: snapshot.appKey,
    })
  })

  it("replaces the cached snapshot on subsequent pushes", () => {
    const first = {
      type: "connectionInfoChanged" as const,
      canUpload: false,
      uploadMode: "unavailable" as const,
      identity: undefined,
      appKey: undefined,
    }
    const second = {
      type: "connectionInfoChanged" as const,
      canUpload: true,
      uploadMode: "subsidised" as const,
      identity: {
        id: "0x3333333333333333333333333333333333333333",
        name: "bob",
        address: "0x3333333333333333333333333333333333333333",
        avatar: generatedAvatar("0x3333333333333333333333333333333333333333"),
      },
      appKey: undefined,
    }

    ;(client as never)["handleIframeMessage"](first)
    ;(client as never)["handleIframeMessage"](second)
    ;(client as never)["ready"] = true

    expect(onConnectionChange).toHaveBeenCalledTimes(2)
    expect(client.connectionInfo.identity?.name).toBe("bob")
    expect(client.connectionInfo.canUpload).toBe(true)
  })

  it("throws from connectionInfo getter before initialize()", () => {
    expect(() => client.connectionInfo).toThrow(
      "SwarmIdClient not initialized. Call initialize() first.",
    )
  })
})

describe("SwarmIdClient request seam", () => {
  let client: SwarmIdClient
  let postMessage: ReturnType<typeof vi.fn>

  // Deliver an iframe→parent message as if it passed the origin/source checks
  const deliver = (message: unknown) =>
    (client as never)["handleIframeMessage"](message)

  const lastPostedMessage = () =>
    postMessage.mock.calls[postMessage.mock.calls.length - 1][0]

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn(),
    })
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue({
        style: {},
        onload: null,
        onerror: null,
        src: "",
        contentWindow: { postMessage: vi.fn() },
      }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    })

    client = new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: { name: "Test App", description: "A test application" },
    })
    postMessage = vi.fn()
    ;(client as never)["ready"] = true
    ;(client as never)["iframe"] = {
      style: {},
      contentWindow: { postMessage },
    }
  })

  it("downloadData sends plain non-ACT options (#420)", async () => {
    const reference = "a".repeat(64)
    const data = new Uint8Array([1, 2, 3])

    const promise = client.downloadData(reference, { timeoutMs: 5000 })

    // The outgoing message passed the client's schema validation and was posted
    expect(postMessage).toHaveBeenCalledTimes(1)
    const sent = lastPostedMessage()
    expect(sent).toMatchObject({
      type: "downloadData",
      reference,
      options: { timeoutMs: 5000 },
    })

    deliver({ type: "downloadDataResponse", requestId: sent.requestId, data })
    await expect(promise).resolves.toEqual(data)
  })

  it("getPostageBatches rejects on a proxy error message", async () => {
    const promise = client.getPostageBatches()

    const sent = lastPostedMessage()
    expect(sent).toMatchObject({ type: "getPostageBatches" })

    deliver({
      type: "error",
      requestId: sent.requestId,
      error: "Bee node unreachable",
    })
    await expect(promise).rejects.toThrow("Bee node unreachable")
  })

  it("getPostageBatches returns the account's full batch list (doc §2)", async () => {
    const promise = client.getPostageBatches()

    const sent = lastPostedMessage()
    expect(sent).toMatchObject({ type: "getPostageBatches" })

    const postageBatches = [
      { batchID: "aa".repeat(32), isDefault: false },
      { batchID: "bb".repeat(32), isDefault: true },
    ]
    deliver({
      type: "getPostageBatchesResponse",
      requestId: sent.requestId,
      postageBatches,
    })
    await expect(promise).resolves.toEqual(postageBatches)
  })

  it("epoch feed uploadReference targets the SOC at the payload's batch", async () => {
    const batchID = "cc".repeat(32)
    const writer = client.makeEpochFeedWriter({ topic: "dd".repeat(32) })

    void writer.uploadReference("ee".repeat(32), {
      uploadOptions: { batchID },
    })

    // Without this the payload lands on the targeted batch while the feed SOC
    // goes to the resolved default — one dataset across two batches with
    // independent TTLs.
    expect(lastPostedMessage()).toMatchObject({
      type: "epochFeedUploadReference",
      batchID,
    })
  })

  it("deriveAppSecret round-trips the label and returns the secret (#520)", async () => {
    const secret = new Uint8Array([9, 8, 7, 6])

    const promise = client.deriveAppSecret("topic-seed")

    const sent = lastPostedMessage()
    expect(sent).toMatchObject({ type: "deriveAppSecret", label: "topic-seed" })

    deliver({
      type: "deriveAppSecretResponse",
      requestId: sent.requestId,
      secret,
    })
    await expect(promise).resolves.toEqual(secret)
  })

  it("deriveAppSecret rejects when the proxy is not authenticated (#520)", async () => {
    const promise = client.deriveAppSecret("topic-seed")

    const sent = lastPostedMessage()
    deliver({
      type: "error",
      requestId: sent.requestId,
      error: "Not authenticated. Please login first.",
    })
    await expect(promise).rejects.toThrow("Not authenticated")
  })
})

describe("SwarmIdClient init-timeout timers (#421)", () => {
  // A distinctive value so the init timers are identifiable by delay.
  const INIT_TIMEOUT = 12345

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn(),
    })
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue({
        style: {},
        onload: null,
        onerror: null,
        src: "",
        contentWindow: { postMessage: vi.fn() },
      }),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    })
  })

  function makeClient(): SwarmIdClient {
    return new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: { name: "Test App", description: "A test application" },
      initializationTimeout: INIT_TIMEOUT,
    })
  }

  it("arms no init-timeout timer at construction", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
    makeClient()
    const initTimers = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => ms === INIT_TIMEOUT,
    )
    expect(initTimers).toHaveLength(0)
  })

  it("does not reject an init timeout when never initialized", async () => {
    vi.useFakeTimers()
    try {
      const rejections: unknown[] = []
      const onUnhandled = (reason: unknown) => rejections.push(reason)
      process.on("unhandledRejection", onUnhandled)

      makeClient()
      await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 100)
      // Let any microtask-queued rejection surface.
      await Promise.resolve()

      process.off("unhandledRejection", onUnhandled)
      expect(rejections).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
