// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

import { DEFAULT_BEE_NODE_URL } from "./schemas"
import { SwarmIdProxy } from "./swarm-id-proxy"
import { deriveSecret } from "./utils/key-derivation"
import { uint8ArrayToHex } from "./utils/hex"
import { STORAGE_KEY_NETWORK_SETTINGS } from "./types"
import type { ButtonConfig } from "./types"
import type { StampLifetimeFields } from "./utils/stamp-lifespan"

/**
 * A view of the proxy that admits to the private members these tests drive.
 * A spy on `proxy as never` is itself typed `never`, so nothing can be
 * chained on it.
 */
type ProxyInternals = {
  loadAuthData: () => Promise<unknown>
  handleDeriveAppSecret: (
    message: { type: string; requestId: string; label: string },
    event: MessageEvent,
  ) => Promise<void>
  authenticated: boolean
  appSecret: string
  postageBatchId?: string
  signerKey?: string
  stamper?: unknown
  stampLifetime?: StampLifetimeFields
  buildConnectionInfo: () => {
    canUpload: boolean
    uploadMode: string
    uploadUnavailableReason?: string
  }
  ensureCanUpload: () => void
  withModeAwareWriteLock: <T>(
    targetOptions: undefined,
    operation: (target: unknown) => Promise<T>,
  ) => Promise<T>
  initializeStamper: (stampDepth: number) => Promise<void>
  lookupAccountForApp: () => Promise<unknown>
  /** The Bee client the proxy reads (and subsidised-uploads) through now. */
  bee: { url: string }
}

const internals = (p: SwarmIdProxy): ProxyInternals =>
  p as unknown as ProxyInternals

/** bee-js keeps a client's URL without its trailing slash. */
const clientUrl = (url: string): string => url.replace(/\/$/, "")

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
    vi.spyOn(internals(proxy), "loadAuthData").mockRejectedValue(
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
    } as unknown as MessageEvent)

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
    internals(proxy).handleDeriveAppSecret(
      { type: "deriveAppSecret", requestId: "r1", label },
      { source, origin: PARENT_ORIGIN } as unknown as MessageEvent,
    )

  const lastMessage = () =>
    source.postMessage.mock.calls[source.postMessage.mock.calls.length - 1][0]

  it("returns HMAC(appSecret, label) as bytes, stable and label-scoped", async () => {
    internals(proxy).authenticated = true
    internals(proxy).appSecret = APP_SECRET_HEX

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
    expect(lastMessage()).toMatchObject({
      type: "error",
      requestId: "r1",
      code: "not-authenticated",
    })
  })
})

describe("SwarmIdProxy honours a Bee URL change mid-session (#515)", () => {
  const NEW_BEE_URL = "https://custom-node.example.com/"
  let storageListeners: Array<(event: StorageEvent) => void>
  let store: Map<string, string>
  let proxy: SwarmIdProxy

  const setNetworkSettings = (beeNodeUrl: string) =>
    store.set(
      STORAGE_KEY_NETWORK_SETTINGS,
      JSON.stringify({ beeNodeUrl, gnosisRpcUrl: "https://rpc.example.com/" }),
    )

  const fireStorage = (key: string | undefined) =>
    storageListeners.forEach((listener) => listener({ key } as StorageEvent))

  beforeEach(() => {
    vi.restoreAllMocks()

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
    expect(internals(proxy).bee.url).toBe(clientUrl(DEFAULT_BEE_NODE_URL))

    setNetworkSettings(NEW_BEE_URL)
    fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

    expect(internals(proxy).bee.url).toBe(clientUrl(NEW_BEE_URL))
  })

  it("ignores storage events for other keys and unchanged URLs", () => {
    const client = internals(proxy).bee

    fireStorage("some-other-key")
    setNetworkSettings(DEFAULT_BEE_NODE_URL)
    fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

    expect(internals(proxy).bee).toBe(client)
  })
})

// The button is painted INSIDE the cross-origin iframe, so `buttonConfig` is
// the only channel the embedding page has for styling it (#779).
describe("SwarmIdProxy auth button typography (#779)", () => {
  type ButtonInternals = {
    buttonConfig: ButtonConfig | undefined
    authButtonContainer: unknown
    showAuthButton: () => void
  }

  type FakeButton = {
    style: Record<string, string>
    textContent: string
    disabled: boolean
  }

  let proxy: SwarmIdProxy

  beforeEach(() => {
    vi.restoreAllMocks()

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://id.example.com" },
    })
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        style: {} as Record<string, string>,
        textContent: "",
        disabled: false,
        addEventListener: vi.fn(),
      })),
    })

    proxy = new SwarmIdProxy()
  })

  /** Render the button with `config` and hand back the styles it carries. */
  const render = (config: ButtonConfig): Record<string, string> => {
    const buttons: FakeButton[] = []
    const internal = proxy as unknown as ButtonInternals
    internal.buttonConfig = config
    internal.authButtonContainer = {
      innerHTML: "stale",
      appendChild: (button: FakeButton) => buttons.push(button),
    }

    internal.showAuthButton()

    expect(buttons).toHaveLength(1)
    return buttons[0].style
  }

  it("applies fontFamily, fontSize and fontWeight to the button", () => {
    const style = render({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: "18px",
      fontWeight: "300",
    })

    expect(style.fontFamily).toBe("Inter, system-ui, sans-serif")
    expect(style.fontSize).toBe("18px")
    expect(style.fontWeight).toBe("300")
  })

  it("renders a numeric fontWeight as the CSS string it has to be", () => {
    expect(render({ fontWeight: 500 }).fontWeight).toBe("500")
  })

  it("keeps the built-in size and weight, and no font-family, when unset", () => {
    const style = render({ backgroundColor: "#000" })

    expect(style.fontSize).toBe("14px")
    expect(style.fontWeight).toBe("600")
    // Deliberately unset rather than `inherit`: inheriting would pick up the
    // IFRAME's font, which is no closer to the embedding page.
    expect(style.fontFamily).toBeUndefined()
  })
})

describe("SwarmIdProxy subsidised-mode selection", () => {
  const GATEWAY_URL = "https://gateway.example.com/"
  const CUSTOM_BEE_URL = "https://custom-node.example.com/"
  const APP_SECRET_HEX = "11".repeat(32)
  const BATCH_ID = "22".repeat(32)
  const SIGNER_KEY = "33".repeat(32)
  const STAMP_DEPTH = 17
  /** A TTL measured twice its own length ago: it has run out. */
  const EXPIRED_TTL_SECONDS = 60
  const MEASURED_AGO_MS = 120_000

  /**
   * The two stored records the session refuses to stamp with even once the
   * stamper has built from them — the refusal is read off the record.
   */
  const REFUSED_DRIVES = [
    {
      reason: "stamp-expired",
      lifetime: (): StampLifetimeFields => ({
        batchTTL: EXPIRED_TTL_SECONDS,
        createdAt: Date.now() - MEASURED_AGO_MS,
      }),
    },
    {
      reason: "stamp-not-usable",
      lifetime: (): StampLifetimeFields => ({
        createdAt: Date.now(),
        usable: false,
      }),
    },
  ]

  let proxy: SwarmIdProxy
  let parentWindow: { postMessage: ReturnType<typeof vi.fn> }
  let messageListener: MessageListener
  let storageListeners: Array<(event: StorageEvent) => void>
  let store: Map<string, string>
  let localStorageFake: Storage

  const setNetworkSettings = (beeNodeUrl: string) =>
    store.set(
      STORAGE_KEY_NETWORK_SETTINGS,
      JSON.stringify({ beeNodeUrl, gnosisRpcUrl: "https://rpc.example.com/" }),
    )

  const fireStorage = (key: string) =>
    storageListeners.forEach((listener) => listener({ key } as StorageEvent))

  function mountProxy(): void {
    const listeners: Record<string, unknown> = {}
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === "storage") {
          storageListeners.push(listener as (event: StorageEvent) => void)
        }
        listeners[type] = listener
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      parent: parentWindow,
      location: { origin: "https://id.example.com", pathname: "/proxy" },
      localStorage: localStorageFake,
    })
    proxy = new SwarmIdProxy()
    messageListener = listeners["message"] as MessageListener
  }

  /** Bind the parent, optionally handing the proxy a subsidised gateway. */
  const identify = (subsidisedGatewayUrl?: string) =>
    messageListener({
      data: {
        type: "parentIdentify",
        requestId: "r1",
        metadata: { name: "Test App" },
        subsidisedGatewayUrl,
      },
      origin: PARENT_ORIGIN,
      source: parentWindow,
    } as unknown as MessageEvent)

  /**
   * Put the proxy in the state a given account leaves it in. `stamper` is the
   * one that is not a straight consequence of the others: `initializeStamper`
   * logs and returns rather than throwing, so a resolved stamp with no stamper
   * is a state the proxy really reaches.
   */
  function setAccountState(state: {
    postageBatchId?: string
    signerKey?: string
    stamper?: boolean
    stampLifetime?: StampLifetimeFields
  }): void {
    internals(proxy).authenticated = true
    internals(proxy).appSecret = APP_SECRET_HEX
    internals(proxy).postageBatchId = state.postageBatchId
    internals(proxy).signerKey = state.signerKey
    internals(proxy).stamper = state.stamper ? { mock: "stamper" } : undefined
    internals(proxy).stampLifetime = state.stampLifetime
  }

  const connectionInfo = () => internals(proxy).buildConnectionInfo()

  /**
   * The target an upload would actually be executed against, through the
   * same two gates every upload handler passes: the refusal check, then the
   * mode-aware write.
   */
  const uploadTarget = async () => {
    internals(proxy).ensureCanUpload()
    return internals(proxy).withModeAwareWriteLock(
      undefined,
      async (target) => target,
    )
  }

  beforeEach(() => {
    vi.restoreAllMocks()

    store = new Map()
    localStorageFake = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    } as unknown as Storage
    vi.stubGlobal("localStorage", localStorageFake)

    storageListeners = []
    parentWindow = { postMessage: vi.fn() }
    mountProxy()
  })

  describe("which mode the dApp is told it is in", () => {
    it("is subsidised when the account has no stamp and a gateway was given", async () => {
      await identify(GATEWAY_URL)
      setAccountState({})

      expect(connectionInfo()).toMatchObject({
        canUpload: true,
        uploadMode: "subsidised",
        uploadUnavailableReason: undefined,
      })
    })

    // The gateway is a fallback, not a preference: a user who can pay for their
    // own upload does.
    it("is user-stamp when the account can stamp for itself", async () => {
      await identify(GATEWAY_URL)
      setAccountState({
        postageBatchId: BATCH_ID,
        signerKey: SIGNER_KEY,
        stamper: true,
      })

      expect(connectionInfo()).toMatchObject({
        canUpload: true,
        uploadMode: "user-stamp",
      })
    })

    it("is unavailable, no-stamp, with neither a stamp nor a gateway", async () => {
      await identify()
      setAccountState({})

      expect(connectionInfo()).toMatchObject({
        canUpload: false,
        uploadMode: "unavailable",
        uploadUnavailableReason: "no-stamp",
      })
    })

    it("is unavailable, stamper-failed, when nothing can cover a failed stamper", async () => {
      await identify()
      setAccountState({ postageBatchId: BATCH_ID, signerKey: SIGNER_KEY })

      expect(connectionInfo()).toMatchObject({
        canUpload: false,
        uploadMode: "unavailable",
        uploadUnavailableReason: "stamper-failed",
      })
    })
  })

  // What the dApp is told and where the bytes go have to be the same answer.
  // `buildConnectionInfo` decides the first and `isSubsidisedModeActive` the
  // second; a stamp counts as usable only with a built stamper and no refusal,
  // and a term one of them misses reports `subsidised, canUpload: true` for a
  // session whose uploads then take the user-stamp branch and fail there.
  describe("where the upload actually goes", () => {
    it("routes to the gateway in subsidised mode", async () => {
      await identify(GATEWAY_URL)
      setAccountState({})

      await expect(uploadTarget()).resolves.toEqual({
        mode: "subsidised",
        gatewayUrl: GATEWAY_URL,
      })
    })

    it("routes a failed stamper to the gateway, as the dApp was told", async () => {
      await identify(GATEWAY_URL)
      setAccountState({ postageBatchId: BATCH_ID, signerKey: SIGNER_KEY })

      expect(connectionInfo().uploadMode).toBe("subsidised")
      await expect(uploadTarget()).resolves.toEqual({
        mode: "subsidised",
        gatewayUrl: GATEWAY_URL,
      })
    })

    it("refuses rather than silently subsidising when no gateway was given", async () => {
      await identify()
      setAccountState({ postageBatchId: BATCH_ID, signerKey: SIGNER_KEY })

      await expect(uploadTarget()).rejects.toMatchObject({
        code: "not-authenticated",
        message: expect.stringContaining("Stamper not initialized"),
      })
    })

    // `initializeStamper` awaits the account lookup before it builds anything,
    // and the stamp is already set while it does: the window in which an
    // upload sees a stamp and no stamper.
    it("routes to the gateway while the stamper is still being built, and after it fails", async () => {
      await identify(GATEWAY_URL)
      setAccountState({ postageBatchId: BATCH_ID, signerKey: SIGNER_KEY })
      let finishLookup: ((account: undefined) => void) | undefined
      vi.spyOn(internals(proxy), "lookupAccountForApp").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishLookup = resolve
          }),
      )

      const init = internals(proxy).initializeStamper(STAMP_DEPTH)
      await vi.waitFor(() => expect(finishLookup).toBeDefined())

      expect(connectionInfo().uploadMode).toBe("subsidised")
      await expect(uploadTarget()).resolves.toEqual({
        mode: "subsidised",
        gatewayUrl: GATEWAY_URL,
      })

      // The lookup finds no account, so the init gives up without a stamper.
      finishLookup!(undefined)
      await init

      expect(internals(proxy).stamper).toBeUndefined()
      expect(connectionInfo().uploadMode).toBe("subsidised")
      await expect(uploadTarget()).resolves.toEqual({
        mode: "subsidised",
        gatewayUrl: GATEWAY_URL,
      })
    })
  })

  // An expired drive, or one whose record says the node cannot use it, still
  // resolves and still builds a stamper. The gateway is the fallback for it
  // as for no stamp at all; without one, the refusal is what the dApp hears.
  describe.each(REFUSED_DRIVES)(
    "a drive refused as $reason",
    ({ reason, lifetime }) => {
      it("falls back to the gateway, in what the dApp is told and where the upload goes", async () => {
        await identify(GATEWAY_URL)
        setAccountState({
          postageBatchId: BATCH_ID,
          signerKey: SIGNER_KEY,
          stamper: true,
          stampLifetime: lifetime(),
        })

        expect(connectionInfo()).toMatchObject({
          canUpload: true,
          uploadMode: "subsidised",
          uploadUnavailableReason: undefined,
        })
        await expect(uploadTarget()).resolves.toEqual({
          mode: "subsidised",
          gatewayUrl: GATEWAY_URL,
        })
      })

      it("is refused with that reason when there is no gateway", async () => {
        await identify()
        setAccountState({
          postageBatchId: BATCH_ID,
          signerKey: SIGNER_KEY,
          stamper: true,
          stampLifetime: lifetime(),
        })

        expect(connectionInfo()).toMatchObject({
          canUpload: false,
          uploadMode: "unavailable",
          uploadUnavailableReason: reason,
        })
        await expect(uploadTarget()).rejects.toMatchObject({
          code: "upload-unavailable",
          reason,
        })
      })
    },
  )

  describe("a custom Bee node drops the dApp's gateway", () => {
    it("drops it at parentIdentify when the node is already custom", async () => {
      setNetworkSettings(CUSTOM_BEE_URL)
      fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

      await identify(GATEWAY_URL)
      setAccountState({})

      expect(connectionInfo()).toMatchObject({
        canUpload: false,
        uploadMode: "unavailable",
      })
    })

    it("drops it mid-session when the node changes", async () => {
      await identify(GATEWAY_URL)
      setAccountState({})
      expect(connectionInfo().uploadMode).toBe("subsidised")

      setNetworkSettings(CUSTOM_BEE_URL)
      fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

      expect(connectionInfo().uploadMode).toBe("unavailable")
      expect(internals(proxy).bee.url).toBe(clientUrl(CUSTOM_BEE_URL))
    })

    // Documented one-way door: going back to the default node does NOT bring
    // the gateway back — that needs a fresh parentIdentify (a dApp reload).
    it("does not bring it back when the node returns to the default", async () => {
      await identify(GATEWAY_URL)
      setAccountState({})
      setNetworkSettings(CUSTOM_BEE_URL)
      fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

      setNetworkSettings(DEFAULT_BEE_NODE_URL)
      fireStorage(STORAGE_KEY_NETWORK_SETTINGS)

      expect(connectionInfo().uploadMode).toBe("unavailable")
      expect(internals(proxy).bee.url).toBe(clientUrl(DEFAULT_BEE_NODE_URL))
    })
  })

  // Downloads have to come from the same place the uploads went, or a dApp
  // reads back a 404 for the chunk it just wrote.
  it("points the Bee client at the gateway in subsidised mode", async () => {
    await identify(GATEWAY_URL)

    expect(internals(proxy).bee.url).toBe(clientUrl(GATEWAY_URL))
  })
})
