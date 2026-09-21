// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Mock, MockInstance } from "vitest"
import { SwarmIdClient } from "./swarm-id-client"
import { SwarmIdError } from "./errors"
import type { ConnectionInfo, IframeToParentMessage } from "./types"
import { generatedAvatar } from "./utils/avatar"

/**
 * A view of the client that admits to the private members these tests drive.
 * `vi.spyOn(client, "ensureReady")` does not compile — the method is private —
 * and a spy on `client as never` is itself typed `never`, so nothing can be
 * chained on it. Naming the shape once keeps the casts honest and the spies
 * chainable.
 */
type ClientInternals = {
  ensureReady: () => void
  sendRequest: (message: unknown) => Promise<unknown>
  handleIframeMessage: (message: IframeToParentMessage) => void
  ready: boolean
  iframe: unknown
  storageShared?: boolean
}

const internals = (c: SwarmIdClient): ClientInternals =>
  c as unknown as ClientInternals

describe("SwarmIdClient connect()", () => {
  let client: SwarmIdClient

  beforeEach(() => {
    vi.restoreAllMocks()

    // Mock window object and its properties. `open` returns a stand-in window
    // explicitly: the callers read its result to tell an opened popup from a
    // blocked one, so a mock returning `undefined` would mean "blocked" and
    // every happy path would take the failure branch.
    const mockWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn().mockReturnValue({ closed: false }),
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

  /** What the proxy reported about its own storage on `proxyReady`. */
  function setStorageShared(shared: boolean | undefined) {
    internals(client).storageShared = shared
  }

  // The transport is a property of the iframe's STORAGE, not of the browser
  // (#613). A partitioned iframe can only be reached by the popup it opened
  // itself, and no user agent tells you which mode you are in.
  describe("shared storage", () => {
    it("opens the popup from the parent, keeping the user gesture", async () => {
      vi.spyOn(internals(client), "ensureReady").mockImplementation(() => {})
      setStorageShared(true)
      const sendRequestSpy = vi.spyOn(internals(client), "sendRequest")

      await client.connect()

      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining("https://swarm-id.example.com/connect#origin="),
        "_blank",
      )
      // Even on WebKit: the user agent no longer decides this.
      expect(sendRequestSpy).not.toHaveBeenCalled()
    })

    // Nothing opened, so there is no connect in progress to report. This
    // branch used to discard `window.open`'s result and resolve regardless.
    it("throws when that popup is blocked", async () => {
      vi.spyOn(internals(client), "ensureReady").mockImplementation(() => {})
      setStorageShared(true)
      vi.mocked(window.open).mockReturnValue(null)

      await expect(client.connect()).rejects.toThrow(
        "Failed to open authentication popup",
      )
    })
  })

  describe("partitioned or unproven storage", () => {
    it.each([false, undefined])(
      "delegates to the proxy when storageShared is %s",
      async (storageShared) => {
        vi.spyOn(internals(client), "ensureReady").mockImplementation(() => {})
        setStorageShared(storageShared)
        const sendRequestSpy = vi
          .spyOn(internals(client), "sendRequest")
          .mockResolvedValue({
            type: "connectResponse",
            requestId: "test",
            success: true,
          })

        await client.connect()

        expect(sendRequestSpy).toHaveBeenCalledWith(
          expect.objectContaining({ type: "connect" }),
        )
        // The proxy opened it; opening a second one from here would be two
        // popups for one click.
        expect(window.open).not.toHaveBeenCalled()
      },
    )

    // A delegated popup can be blocked — the click was in the parent, and no
    // activation crosses the postMessage. Falling back to the parent is what
    // this branch had before the storage mode decided it, so it can never be
    // worse than not asking at all.
    it("falls back to opening from the parent when the proxy's popup is blocked", async () => {
      vi.spyOn(internals(client), "ensureReady").mockImplementation(() => {})
      setStorageShared(false)
      vi.spyOn(internals(client), "sendRequest").mockResolvedValue({
        type: "connectResponse",
        requestId: "test",
        success: false,
      })

      await client.connect()

      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining("https://swarm-id.example.com/connect#origin="),
        "_blank",
      )
    })

    it("throws when the fallback popup is blocked too", async () => {
      vi.spyOn(internals(client), "ensureReady").mockImplementation(() => {})
      setStorageShared(false)
      vi.spyOn(internals(client), "sendRequest").mockResolvedValue({
        type: "connectResponse",
        requestId: "test",
        success: false,
      })
      vi.mocked(window.open).mockReturnValue(null)

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
  let onConnectionChange: Mock<(info: ConnectionInfo) => void>

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

    internals(client).handleIframeMessage(snapshot)

    expect(onConnectionChange).toHaveBeenCalledTimes(1)
    expect(onConnectionChange).toHaveBeenCalledWith({
      canUpload: snapshot.canUpload,
      storagePartitioned: snapshot.storagePartitioned,
      uploadMode: snapshot.uploadMode,
      identity: snapshot.identity,
      appKey: snapshot.appKey,
    })

    // `connectionInfo` getter calls ensureReady — mark client as ready for the read
    internals(client).ready = true
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

    internals(client).handleIframeMessage(first)
    internals(client).handleIframeMessage(second)
    internals(client).ready = true

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
    internals(client).handleIframeMessage(message as IframeToParentMessage)

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
    internals(client).ready = true
    internals(client).iframe = {
      style: {},
      contentWindow: { postMessage },
    }
  })

  // #761: a failure used to arrive as `new Error(message.error)`, the status
  // and Bee's message flattened into the string or dropped.
  it("rejects with a SwarmIdError carrying the wire's code, status and Bee message", async () => {
    const promise = client.downloadData("a".repeat(64))
    const { requestId } = lastPostedMessage()
    deliver({
      type: "error",
      requestId,
      error: "Request failed with status code 404",
      code: "bee-rejected",
      status: 404,
      beeMessage: "chunk not found",
      url: "http://bee.example/chunks/aa",
    })
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SwarmIdError)
    expect(error).toMatchObject({
      name: "SwarmIdError",
      message: "Request failed with status code 404",
      code: "bee-rejected",
      status: 404,
      beeMessage: "chunk not found",
      url: "http://bee.example/chunks/aa",
    })
  })

  it("carries the upload-unavailable reason through", async () => {
    const promise = client.uploadData(new Uint8Array([1]))
    const { requestId } = lastPostedMessage()
    deliver({
      type: "error",
      requestId,
      error: "drive expired",
      code: "upload-unavailable",
      reason: "stamp-expired",
    })
    await expect(promise).rejects.toMatchObject({
      code: "upload-unavailable",
      reason: "stamp-expired",
    })
  })

  it("times the round trip out with a SwarmIdError of code timeout", async () => {
    vi.useFakeTimers()
    try {
      const promise = client.downloadData("a".repeat(64), undefined, {
        timeout: 1000,
      })
      const settled = promise.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(1001)
      const error = await settled
      expect(error).toBeInstanceOf(SwarmIdError)
      expect(error).toMatchObject({ code: "timeout" })
      expect((error as Error).message).toMatch(/timeout after 1000ms/)
    } finally {
      vi.useRealTimers()
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

  // #775 review: `requestOptions.timeout` used to reach only the Bee request
  // inside the iframe, while the client's own round-trip timer kept the
  // constructor default — so a per-call value above 30 s still rejected at
  // 30 s, with the same message the caller had just tried to escape.
  it("a per-call requestOptions.timeout bounds the whole round trip", async () => {
    const DEFAULT_CLIENT_TIMEOUT_MS = 30_000
    const PER_CALL_TIMEOUT_MS = 60_000
    vi.useFakeTimers()
    try {
      let settled: unknown
      client
        .downloadData("a".repeat(64), undefined, {
          timeout: PER_CALL_TIMEOUT_MS,
        })
        .catch((error: unknown) => {
          settled = error
        })
      await vi.advanceTimersByTimeAsync(DEFAULT_CLIENT_TIMEOUT_MS)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(
        PER_CALL_TIMEOUT_MS - DEFAULT_CLIENT_TIMEOUT_MS,
      )
      expect(String(settled)).toContain(
        `Request timeout after ${PER_CALL_TIMEOUT_MS}ms`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  // The other direction: "replaces", not "extends" — a per-call value BELOW
  // the client default has to fire at its own value, not wait for 30 s.
  it("a per-call timeout below the client default fires at its own value", async () => {
    const PER_CALL_TIMEOUT_MS = 5_000
    vi.useFakeTimers()
    try {
      let settled: unknown
      client
        .downloadData("a".repeat(64), undefined, {
          timeout: PER_CALL_TIMEOUT_MS,
        })
        .catch((error: unknown) => {
          settled = error
        })
      await vi.advanceTimersByTimeAsync(PER_CALL_TIMEOUT_MS)
      expect(String(settled)).toContain(
        `Request timeout after ${PER_CALL_TIMEOUT_MS}ms`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  // A value `setTimeout` cannot honour must not become an instant rejection.
  // Zero means "no timeout" to Bee, which is where this option went before it
  // also bound the round trip; taken literally it would do the opposite.
  it.each([
    ["zero", 0],
    ["a negative", -1],
  ])(
    "keeps the client default for %s per-call timeout",
    async (_label, timeout) => {
      const DEFAULT_CLIENT_TIMEOUT_MS = 30_000
      vi.useFakeTimers()
      try {
        let settled: unknown
        client
          .downloadData("a".repeat(64), undefined, { timeout })
          .catch((error: unknown) => {
            settled = error
          })
        await vi.advanceTimersByTimeAsync(1)
        expect(settled).toBeUndefined()
        await vi.advanceTimersByTimeAsync(DEFAULT_CLIENT_TIMEOUT_MS)
        expect(String(settled)).toContain(
          `Request timeout after ${DEFAULT_CLIENT_TIMEOUT_MS}ms`,
        )
      } finally {
        vi.useRealTimers()
      }
    },
  )

  // Past the 32-bit timer ceiling `setTimeout` wraps and fires almost at
  // once, so "as long as it takes" would become "immediately".
  it("clamps a per-call timeout past the timer ceiling to the ceiling", async () => {
    const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
    vi.useFakeTimers()
    try {
      let settled: unknown
      client
        .downloadData("a".repeat(64), undefined, { timeout: 2 ** 31 })
        .catch((error: unknown) => {
          settled = error
        })
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS - 1)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(String(settled)).toContain(
        `Request timeout after ${MAX_TIMER_DELAY_MS}ms`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  // #750: the folder API takes what bee-js takes — a FileList, File[], or
  // `{ path, file }` pairs — and ships `{ path, data, contentType }` so the
  // proxy builds the manifest. A File's own path comes from webkitdirectory.
  it("uploadFiles normalizes File[] and { path, file } pairs into one message", async () => {
    const picked = new File(["<h1>hi</h1>"], "index.html", {
      type: "text/html",
    })
    Object.defineProperty(picked, "webkitRelativePath", {
      value: "site/index.html",
    })
    const named = {
      path: "assets/a.bin",
      file: new Blob([new Uint8Array([1, 2])]),
    }

    const promise = client.uploadFiles([picked, named], {
      indexDocument: "index.html",
      onProgress: () => {},
    })
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    const sent = lastPostedMessage()
    expect(sent).toMatchObject({
      type: "uploadFiles",
      options: { indexDocument: "index.html" },
      enableProgress: true,
    })
    expect(sent.options).not.toHaveProperty("onProgress")
    expect(sent.files).toEqual([
      {
        path: "index.html",
        data: new TextEncoder().encode("<h1>hi</h1>"),
        contentType: "text/html",
      },
      {
        path: "assets/a.bin",
        data: new Uint8Array([1, 2]),
        contentType: undefined,
      },
    ])

    const reference = "b".repeat(128)
    deliver({
      type: "uploadFilesResponse",
      requestId: sent.requestId,
      reference,
    })
    await expect(promise).resolves.toEqual({ reference, tagUid: undefined })
  })

  it("listFiles returns the proxy's entries", async () => {
    const reference = "c".repeat(64)
    const entries = [
      {
        path: "index.html",
        reference: "d".repeat(64),
        contentType: "text/html",
      },
    ]
    const promise = client.listFiles(reference)
    const sent = lastPostedMessage()
    expect(sent).toMatchObject({ type: "listFiles", reference })
    deliver({ type: "listFilesResponse", requestId: sent.requestId, entries })
    await expect(promise).resolves.toEqual(entries)
  })

  it("getPostageBatch rejects on a proxy error message", async () => {
    const promise = client.getPostageBatch()

    const sent = lastPostedMessage()
    expect(sent).toMatchObject({ type: "getPostageBatch" })

    deliver({
      type: "error",
      requestId: sent.requestId,
      error: "Bee node unreachable",
    })
    await expect(promise).rejects.toThrow("Bee node unreachable")
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

describe("SwarmIdClient window message filtering", () => {
  let client: SwarmIdClient
  let listener: (event: unknown) => void
  let contentWindow: object
  let warn: MockInstance<typeof console.warn>

  /** The listener the constructor registered on `window`. */
  function registeredMessageListener(): (event: unknown) => void {
    const registration = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === "message")
    if (!registration) {
      throw new Error("no message listener was registered")
    }
    return registration[1] as unknown as (event: unknown) => void
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
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
    listener = registeredMessageListener()
    contentWindow = { postMessage: vi.fn() }
    internals(client).iframe = { style: {}, contentWindow }
  })

  // Every page carries message traffic of its own — devtools, HMR, wallet
  // extensions — and none of it was ever addressed to this client.
  it("drops a message from another window silently", () => {
    listener({
      origin: "http://localhost:5173",
      source: { postMessage: vi.fn() },
      data: { type: "webpackHotUpdate" },
    })

    expect(warn).not.toHaveBeenCalled()
  })

  it("drops a message silently before the iframe exists", () => {
    internals(client).iframe = undefined

    listener({
      origin: "http://localhost:5173",
      source: { postMessage: vi.fn() },
      data: { type: "proxyInitialized" },
    })

    expect(warn).not.toHaveBeenCalled()
  })

  // The other direction: a filter that dropped everything would pass every
  // rejection test above, so one message has to be shown getting through.
  it("handles a valid message from our iframe at the expected origin", () => {
    expect(internals(client).ready).toBe(false)

    listener({
      origin: "https://swarm-id.example.com",
      source: contentWindow,
      data: {
        type: "proxyReady",
        authenticated: false,
        parentOrigin: "https://localhost",
        storageShared: true,
      },
    })

    expect(warn).not.toHaveBeenCalled()
    expect(internals(client).ready).toBe(true)
    expect(internals(client).storageShared).toBe(true)
  })

  // From our own iframe, so the mismatch is ours to report: the frame is
  // serving something other than the configured identity origin.
  it("warns about a wrong origin from our iframe's window", () => {
    listener({
      origin: "https://evil.example.com",
      source: contentWindow,
      data: { type: "proxyReady" },
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unauthorized origin"),
      "https://evil.example.com",
    )
  })

  it("warns about a message from our iframe that fails validation", () => {
    listener({
      origin: "https://swarm-id.example.com",
      source: contentWindow,
      data: { type: "notAMessageWeKnow" },
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid message format"),
      expect.anything(),
      expect.anything(),
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

// A server render (Next.js App Router, SvelteKit with SSR) reaches the
// constructor with no `window`. It used to throw a bare `ReferenceError` from
// inside `setupMessageListener` — in the published build, a stack into
// minified code that named neither the package nor the fix (#778).
describe("SwarmIdClient on a server", () => {
  it("says the package is browser-only and where to construct instead", () => {
    vi.unstubAllGlobals()
    expect(typeof window).toBe("undefined")
    expect(
      () =>
        new SwarmIdClient({
          iframeOrigin: "https://swarm-id.snaha.net",
          metadata: { name: "ssr" },
        }),
    ).toThrow(/@snaha\/swarm-id .*browser/)
  })
})
