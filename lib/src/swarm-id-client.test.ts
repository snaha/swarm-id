// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"
import { SwarmIdClient } from "./swarm-id-client"
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
  /** The in-flight requests `sendRequest` is holding open. */
  pendingRequests: Map<string, unknown>
}

const internals = (c: SwarmIdClient): ClientInternals =>
  c as unknown as ClientInternals

const IFRAME_ORIGIN = "https://swarm-id.example.com"
const APP_METADATA = { name: "Test App", description: "A test application" }

/**
 * Browser stand-ins that keep the two seams these tests drive: the `message`
 * listener the constructor registers — so a message can be delivered the way
 * the browser delivers it, THROUGH the origin/source/schema gate rather than
 * around it — and the iframe element `initialize()` creates, so its `onload`
 * can be fired on cue.
 */
function stubBrowserGlobals() {
  const messageListeners: Array<(event: MessageEvent) => void> = []
  const iframeContentWindow = { postMessage: vi.fn() }
  const iframeElement = {
    style: {} as Record<string, string>,
    onload: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    src: "",
    contentWindow: iframeContentWindow,
    parentNode: { removeChild: vi.fn() },
  }
  const removeEventListener = vi.fn()

  vi.stubGlobal("window", {
    addEventListener: vi.fn(
      (type: string, listener: (event: MessageEvent) => void) => {
        if (type === "message") messageListeners.push(listener)
      },
    ),
    removeEventListener,
    parent: { postMessage: vi.fn() },
    location: { origin: "https://localhost" },
    open: vi.fn(),
  })
  vi.stubGlobal("document", {
    createElement: vi.fn().mockReturnValue(iframeElement),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  })

  return {
    iframeElement,
    iframeContentWindow,
    removeEventListener,
    /** The handler the client registered — what `destroy()` must hand back. */
    get messageListener() {
      return messageListeners[0]
    },
    /** What the iframe was last told, as `sendMessage` posted it. */
    lastPostedMessage() {
      const calls = iframeContentWindow.postMessage.mock.calls
      return calls[calls.length - 1]?.[0]
    },
    /**
     * Deliver an event the way the browser would. The defaults are the trusted
     * case; pass `origin` or `source` to make it arrive from somewhere else.
     */
    dispatch(event: { origin?: string; source?: unknown; data: unknown }) {
      const messageEvent = {
        origin: event.origin ?? IFRAME_ORIGIN,
        source: "source" in event ? event.source : iframeContentWindow,
        data: event.data,
      } as unknown as MessageEvent
      // Iterate a copy: an upload's progress listener removes itself as the
      // request settles, and that must not shift the iteration underneath us.
      ;[...messageListeners].forEach((listener) => listener(messageEvent))
    },
  }
}

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
  let env: ReturnType<typeof stubBrowserGlobals>
  let onConnectionChange: Mock<(info: ConnectionInfo) => void>

  // Delivered through the listener, not into `handleIframeMessage`: a snapshot
  // shaped like something the proxy cannot actually put on the wire would
  // otherwise pass here and fail only in a browser. Hex is bare — `0x`-prefixed
  // addresses and 68-char public keys are what `IframeToParentMessageSchema`
  // rejects (#427).
  const deliver = (message: unknown) => env.dispatch({ data: message })

  beforeEach(() => {
    vi.restoreAllMocks()
    env = stubBrowserGlobals()

    onConnectionChange = vi.fn()
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: APP_METADATA,
      onConnectionChange,
    })
    internals(client).iframe = env.iframeElement
  })

  it("invokes onConnectionChange with the pushed snapshot and caches it", () => {
    const snapshot = {
      type: "connectionInfoChanged" as const,
      canUpload: true,
      storagePartitioned: undefined,
      uploadMode: "user-stamp" as const,
      identity: {
        id: "11".repeat(20),
        name: "alice",
        address: "11".repeat(20),
        publicKey: "02" + "ab".repeat(32),
        avatar: generatedAvatar("11".repeat(20)),
      },
      appKey: {
        address: "22".repeat(20),
        publicKey: "03" + "cd".repeat(32),
      },
    }

    deliver(snapshot)

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
        id: "33".repeat(20),
        name: "bob",
        address: "33".repeat(20),
        avatar: generatedAvatar("33".repeat(20)),
      },
      appKey: undefined,
    }

    deliver(first)
    deliver(second)
    internals(client).ready = true

    expect(onConnectionChange).toHaveBeenCalledTimes(2)
    expect(client.connectionInfo.identity?.name).toBe("bob")
    expect(client.connectionInfo.canUpload).toBe(true)
  })

  // `uploadUnavailableReason` is `.catch(undefined)` on purpose: the client
  // DROPS a `connectionInfoChanged` it cannot parse, and dropping the first one
  // after `proxyReady` leaves `initialize()` to time out. A proxy from the
  // #616–#642 window still emits the `"download-only"` this lib removed, and
  // deploy-cache skew alone is enough to pair it with a current client — so one
  // unrecognised member must degrade the field, not stop the dApp starting.
  it("keeps a snapshot whose uploadUnavailableReason this lib no longer knows", () => {
    deliver({
      type: "connectionInfoChanged",
      canUpload: false,
      uploadMode: "unavailable",
      uploadUnavailableReason: "download-only",
    })

    expect(onConnectionChange).toHaveBeenCalledTimes(1)
    expect(onConnectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        canUpload: false,
        uploadMode: "unavailable",
        uploadUnavailableReason: undefined,
      }),
    )
  })

  it("keeps a reason it does know", () => {
    deliver({
      type: "connectionInfoChanged",
      canUpload: false,
      uploadMode: "unavailable",
      uploadUnavailableReason: "stamper-failed",
    })

    expect(onConnectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ uploadUnavailableReason: "stamper-failed" }),
    )
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

/** Let the microtask queue drain so an `await` chain can move on. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("SwarmIdClient message gate", () => {
  let client: SwarmIdClient
  let env: ReturnType<typeof stubBrowserGlobals>
  let handled: ReturnType<typeof vi.spyOn>

  /** Well-formed, and from our own iframe: nothing here should drop it. */
  const proxyReady = {
    type: "proxyReady",
    authenticated: false,
    parentOrigin: "https://localhost",
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    env = stubBrowserGlobals()
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: APP_METADATA,
    })
    internals(client).iframe = env.iframeElement
    handled = vi.spyOn(internals(client), "handleIframeMessage")
  })

  it("accepts a message from our iframe at the configured origin", () => {
    env.dispatch({ data: proxyReady })

    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({ type: "proxyReady" }),
    )
  })

  it("rejects a message from another origin", () => {
    env.dispatch({ origin: "https://evil.example", data: proxyReady })

    expect(handled).not.toHaveBeenCalled()
  })

  // The origin check alone does not settle this: any window served from the
  // trusted domain clears it — a sibling iframe the page also embeds, an
  // opener. Only the source check ties a push like `connectionInfoChanged` or
  // `authSuccess` to OUR proxy rather than to a co-origin impostor.
  it("rejects a message from a co-origin window that is not our iframe", () => {
    env.dispatch({ source: { postMessage: vi.fn() }, data: proxyReady })

    expect(handled).not.toHaveBeenCalled()
  })

  it("compares origins, so an iframeOrigin carrying a path still matches", () => {
    const withPath = new SwarmIdClient({
      iframeOrigin: `${IFRAME_ORIGIN}/id`,
      metadata: APP_METADATA,
    })
    internals(withPath).iframe = env.iframeElement
    const handledByPathClient = vi.spyOn(
      internals(withPath),
      "handleIframeMessage",
    )

    env.dispatch({ data: proxyReady })

    expect(handledByPathClient).toHaveBeenCalledTimes(1)
  })

  it("drops a message the receive schema rejects", () => {
    env.dispatch({ data: { type: "proxyReady", authenticated: "yes" } })

    expect(handled).not.toHaveBeenCalled()
  })

  it("drops a message of a type this lib does not know", () => {
    env.dispatch({ data: { type: "somethingNewer", requestId: "req-1" } })

    expect(handled).not.toHaveBeenCalled()
  })
})

describe("SwarmIdClient request timeout", () => {
  const TIMEOUT_MS = 5000
  let client: SwarmIdClient
  let env: ReturnType<typeof stubBrowserGlobals>

  beforeEach(() => {
    vi.restoreAllMocks()
    env = stubBrowserGlobals()
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: APP_METADATA,
      timeout: TIMEOUT_MS,
    })
    internals(client).ready = true
    internals(client).iframe = env.iframeElement
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("rejects a request the proxy never answers, and forgets it", async () => {
    vi.useFakeTimers()
    const request = client.getPostageBatch()
    const rejected = expect(request).rejects.toThrow(
      `Request timeout after ${TIMEOUT_MS}ms`,
    )

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

    await rejected
    expect(internals(client).pendingRequests.size).toBe(0)
  })

  // The pending is gone by then, so the late answer has nothing to settle —
  // what matters is that it does not throw or resurrect an entry.
  it("ignores an answer that arrives after the timeout", async () => {
    vi.useFakeTimers()
    const request = client.getPostageBatch()
    const rejected = expect(request).rejects.toThrow("Request timeout")
    const { requestId } = env.lastPostedMessage()

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await rejected

    env.dispatch({ data: { type: "getPostageBatchResponse", requestId } })

    expect(internals(client).pendingRequests.size).toBe(0)
  })

  it("clears the timer when an answer settles the request", async () => {
    vi.useFakeTimers()
    const request = client.getPostageBatch()
    const { requestId } = env.lastPostedMessage()
    expect(vi.getTimerCount()).toBe(1)

    env.dispatch({ data: { type: "getPostageBatchResponse", requestId } })

    await expect(request).resolves.toBeUndefined()
    expect(internals(client).pendingRequests.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Progress is reported on its own listener and deliberately does not settle
  // the pending. It does not move the deadline either: `timeout` is a flat cap
  // on the whole request, so an upload still transferring when it expires is
  // rejected mid-flight.
  it("reports progress without settling the request or extending its deadline", async () => {
    vi.useFakeTimers()
    const progress: Array<{ total: number; processed: number }> = []
    const upload = client.uploadData(new Uint8Array([1, 2, 3]), {
      onProgress: (update) => progress.push(update),
    })
    const rejected = expect(upload).rejects.toThrow(
      `Request timeout after ${TIMEOUT_MS}ms`,
    )
    const { requestId } = env.lastPostedMessage()

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    env.dispatch({
      data: { type: "uploadProgress", requestId, total: 10, processed: 9 },
    })

    expect(progress).toEqual([{ total: 10, processed: 9 }])
    expect(internals(client).pendingRequests.size).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    await rejected
  })
})

describe("SwarmIdClient destroy()", () => {
  let client: SwarmIdClient
  let env: ReturnType<typeof stubBrowserGlobals>

  beforeEach(() => {
    vi.restoreAllMocks()
    env = stubBrowserGlobals()
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: APP_METADATA,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A client past `initialize()`, without running it. */
  function markReady() {
    internals(client).ready = true
    internals(client).iframe = env.iframeElement
  }

  it("rejects every in-flight request", async () => {
    markReady()
    const batch = client.getPostageBatch()
    const node = client.getNodeInfo()
    const rejected = Promise.all([
      expect(batch).rejects.toThrow("Client destroyed"),
      expect(node).rejects.toThrow("Client destroyed"),
    ])

    client.destroy()

    await rejected
    expect(internals(client).pendingRequests.size).toBe(0)
  })

  it("clears the timers those requests armed", () => {
    vi.useFakeTimers()
    markReady()
    client.getPostageBatch().catch(() => {})
    client.getNodeInfo().catch(() => {})
    expect(vi.getTimerCount()).toBe(2)

    client.destroy()

    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops listening for messages", () => {
    markReady()
    const listener = env.messageListener

    client.destroy()

    expect(env.removeEventListener).toHaveBeenCalledWith("message", listener)
  })

  it("removes the iframe from the document", () => {
    markReady()

    client.destroy()

    expect(env.iframeElement.parentNode.removeChild).toHaveBeenCalledWith(
      env.iframeElement,
    )
    expect(internals(client).iframe).toBeUndefined()
  })

  // Without this the caller waits out the full initializationTimeout for a
  // proxy that is already gone.
  it("unblocks an initialize() still waiting on the proxy", async () => {
    const initializing = client.initialize()
    const rejected = expect(initializing).rejects.toThrow("Client destroyed")

    await flush()
    env.iframeElement.onload?.()
    await flush()
    env.dispatch({ data: { type: "proxyInitialized" } })
    await flush()
    // Past `parentIdentify`, now waiting on a `proxyReady` that never comes.
    expect(env.lastPostedMessage()).toMatchObject({ type: "parentIdentify" })

    client.destroy()

    await rejected
  })
})

describe("SwarmIdClient initialize() sequencing", () => {
  let client: SwarmIdClient
  let env: ReturnType<typeof stubBrowserGlobals>

  beforeEach(() => {
    vi.restoreAllMocks()
    env = stubBrowserGlobals()
    client = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: APP_METADATA,
    })
  })

  it("identifies the parent only once the proxy says it is initialized", async () => {
    const initializing = client.initialize()
    initializing.catch(() => {})

    await flush()
    env.iframeElement.onload?.()
    await flush()
    expect(env.iframeContentWindow.postMessage).not.toHaveBeenCalled()

    // `proxyInitialized` is handled BEFORE the origin check — it rides a
    // wildcard origin — so the source check is the only thing standing between
    // any window on the page and the handshake.
    env.dispatch({ data: { type: "proxyInitialized" }, source: {} })
    await flush()
    expect(env.iframeContentWindow.postMessage).not.toHaveBeenCalled()

    env.dispatch({ data: { type: "proxyInitialized" } })
    await flush()
    expect(env.iframeContentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "parentIdentify" }),
      IFRAME_ORIGIN,
    )

    client.destroy()
  })

  it("refuses a second initialize()", async () => {
    const initializing = client.initialize()
    initializing.catch(() => {})

    await expect(client.initialize()).rejects.toThrow(
      "SwarmIdClient already initialized",
    )

    client.destroy()
  })
})
