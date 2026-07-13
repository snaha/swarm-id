// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmIdClient } from "./swarm-id-client"
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
