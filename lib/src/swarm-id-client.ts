// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SwarmIdError } from "./errors"
import type {
  ClientOptions,
  ConnectOptions,
  AuthStatus,
  Avatar,
  ConnectionInfo,
  UploadResult,
  FileData,
  UploadOptions,
  UploadFilesOptions,
  CollectionFileInput,
  CollectionEntry,
  UploadProgress,
  ActUploadOptions,
  DownloadOptions,
  RequestOptions,
  Reference,
  SOCReader,
  SOCWriter,
  SingleOwnerChunk,
  SocRawUploadResult,
  SocRawUploadResponseMessage,
  SocRawUploadMessage,
  SocGetOwnerMessage,
  SocGetOwnerResponseMessage,
  FeedReaderOptions,
  FeedWriterOptions,
  FeedReader,
  FeedWriter,
  EpochFeedDownloadReferenceMessage,
  EpochFeedDownloadReferenceResponseMessage,
  EpochFeedUploadReferenceMessage,
  EpochFeedUploadReferenceResponseMessage,
  FeedGetOwnerMessage,
  FeedGetOwnerResponseMessage,
  EpochFeedDownloadOptions,
  EpochFeedDownloadPayloadResult,
  EpochFeedDownloadReferenceResult,
  EpochFeedUploadOptions,
  EpochFeedUploadResult,
  SequentialFeedReaderOptions,
  SequentialFeedWriterOptions,
  SequentialFeedUpdateOptions,
  SequentialFeedUploadOptions,
  SequentialFeedDownloadRawOptions,
  SequentialFeedUploadRawOptions,
  SequentialFeedPayloadResult,
  SequentialFeedReferenceResult,
  SequentialFeedUploadResult,
  SequentialFeedReader,
  SequentialFeedWriter,
  SequentialFeedGetOwnerMessage,
  SequentialFeedGetOwnerResponseMessage,
  SequentialFeedDownloadPayloadMessage,
  SequentialFeedDownloadPayloadResponseMessage,
  SequentialFeedDownloadRawPayloadMessage,
  SequentialFeedDownloadRawPayloadResponseMessage,
  SequentialFeedDownloadReferenceMessage,
  SequentialFeedDownloadReferenceResponseMessage,
  SequentialFeedUploadPayloadMessage,
  SequentialFeedUploadPayloadResponseMessage,
  SequentialFeedUploadRawPayloadMessage,
  SequentialFeedUploadRawPayloadResponseMessage,
  SequentialFeedUploadReferenceMessage,
  SequentialFeedUploadReferenceResponseMessage,
  CreateFeedManifestMessage,
  CreateFeedManifestResponseMessage,
  SocDownloadMessage,
  SocDownloadResponseMessage,
  SocRawDownloadMessage,
  SocRawDownloadResponseMessage,
  SocUploadResult,
  SocUploadResponseMessage,
  SocUploadMessage,
  ParentToIframeMessage,
  IframeToParentMessage,
  AppMetadata,
  ButtonConfig,
  PostageBatch,
  Drive,
  DriveRequest,
  Permissions,
  AppPermissions,
  DriveTargetOptions,
} from "./types"
import {
  IframeToParentMessageSchema,
  IdentitySiteChosenMessageSchema,
  IDENTITY_SITE_STORAGE_KEY,
  ParentToIframeMessageSchema,
  AppMetadataSchema,
  PermissionsSchema,
} from "./types"
import { EthAddress, Identifier, PrivateKey, Topic } from "@ethersphere/bee-js"
import { generatedAvatar } from "./utils/avatar"
import { uint8ArrayToHex } from "./utils/hex"
import { collectionPath } from "./utils/collection"
import { PERMISSIONS_POPUP_MAX_MS, untilPopupClosed } from "./utils/popup"
import { buildAuthUrl, isHttpUrl, normalizeUrl } from "./utils/url"
import { TimeoutError, withTimeout } from "./utils/promise"

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_IFRAME_PATH = "/proxy"

function rememberedIdentitySite(): string | undefined {
  try {
    return localStorage.getItem(IDENTITY_SITE_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}
/** The largest delay `setTimeout` honours; past it, it fires almost at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30000
/**
 * How long a chosen identity site gets to come up before the client falls back
 * to the configured one (#849): a user waits this long, not the full deadline.
 */
const CHOSEN_SITE_INITIALIZATION_TIMEOUT_MS = 10000
/**
 * The round trip of a `requestPermissions` message: the proxy answers it
 * once its popup closes, at the latest after `PERMISSIONS_POPUP_MAX_MS` — so
 * this is longer by the default timeout, and the call never rejects with
 * `timeout` while the proxy is still watching the popup.
 */
const PERMISSIONS_REQUEST_TIMEOUT_MS =
  PERMISSIONS_POPUP_MAX_MS + DEFAULT_TIMEOUT_MS

/**
 * {@link withTimeout} for one of `initialize()`'s waits: a missed deadline
 * rejects as `init-failed`, the `TimeoutError` kept as its cause, so every
 * way `initialize()` fails to come up carries the same code.
 */
function initDeadline(
  work: Promise<void>,
  ms: number,
  message: string,
): Promise<void> {
  return withTimeout(work, ms, message).catch((error: unknown) => {
    throw error instanceof TimeoutError
      ? new SwarmIdError("init-failed", error.message, { cause: error })
      : error
  })
}

/**
 * Main client library for integrating Swarm ID authentication and storage capabilities
 * into web applications.
 *
 * SwarmIdClient enables parent windows to interact with a Swarm ID iframe proxy,
 * providing secure authentication, identity management, and data upload/download
 * functionality to the Swarm decentralized storage network.
 *
 * @example
 * ```typescript
 * const client = new SwarmIdClient({
 *   iframeOrigin: 'https://swarm-id.example.com',
 *   metadata: {
 *     name: 'My App',
 *     description: 'A decentralized application'
 *   },
 *   onConnectionChange: (info) => {
 *     console.log('Connection changed:', info.identity?.name, info.canUpload)
 *   }
 * })
 *
 * await client.initialize()
 *
 * // Check canUpload — an authenticated user can still lack upload capability
 * // when they have no postage stamp and no subsidised gateway is configured.
 * if (client.connectionInfo.identity && client.connectionInfo.canUpload) {
 *   const result = await client.uploadData(new Uint8Array([1, 2, 3]))
 *   console.log('Uploaded with reference:', result.reference)
 * }
 * ```
 */
export class SwarmIdClient {
  private iframe: HTMLIFrameElement | undefined
  private iframeOrigin: string
  private iframePath: string
  /** What the app configured; what `iframeOrigin` falls back to without a chosen site. */
  private readonly defaultIframeOrigin: string
  private readonly defaultIframePath: string
  /** The connect popup `openAuthWindow` opened, while one is open: the only window besides the iframe this client listens to. */
  private authPopup: Window | null = null
  /** What the proxy's own store prefers, as reported on `proxyReady` (#849). */
  private preferredSite: string | undefined
  /** Set across the re-initialize of an explicit reset, so the default site's remembered preference is not followed straight back. */
  private ignorePreferredSite = false
  /** At most one hop per client: two sites preferring each other must not re-embed forever. */
  private preferenceFollowed = false
  /** The chosen site that did not come up, while this client runs on the configured one instead (#849). */
  private failedSite: string | undefined
  private timeout: number
  private initializationTimeout: number
  private onConnectionChange?: (info: ConnectionInfo) => void
  private lastConnectionInfo: ConnectionInfo | undefined
  private firstConnectionInfoPromise: Promise<void> | undefined
  private firstConnectionInfoResolve?: () => void
  private firstConnectionInfoReject?: (error: SwarmIdError) => void
  private iframeLoadReject?: (error: SwarmIdError) => void
  private popupMode: "popup" | "window"
  private readonly permissions: Permissions | undefined
  private metadata: AppMetadata
  private buttonConfig?: ButtonConfig
  private containerId?: string
  private subsidisedGatewayUrl?: string
  private ready: boolean = false
  /**
   * Whether the proxy iframe can read the trusted domain's first-party store,
   * as reported on `proxyReady`. Decides which transport `connect()` uses
   * (#613); undefined against a proxy that predates the field, which reads as
   * "not proven shared".
   */
  private storageShared: boolean | undefined
  /**
   * The challenge the next connect popup carries, armed by the proxy in its
   * store before it was handed over: on `proxyReady`, then on
   * `challengeArmed` each time an attempt ends.
   */
  private connectChallenge: string | undefined
  private readyPromise: Promise<void> | undefined
  private readyResolve?: () => void
  private readyReject?: (error: SwarmIdError) => void
  private pendingRequests: Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolve: (value: any) => void
      reject: (error: Error) => void
      timeoutId: NodeJS.Timeout
    }
  > = new Map()
  /**
   * Progress callbacks of in-flight uploads, by request id. Dispatched from
   * the one window listener, so progress passes the same source and origin
   * checks as every other message from the iframe.
   */
  private progressListeners: Map<string, (progress: UploadProgress) => void> =
    new Map()
  private requestIdCounter = 0
  private messageListener: ((event: MessageEvent) => void) | undefined
  private proxyInitializedPromise: Promise<void> | undefined
  private proxyInitializedResolve?: () => void
  private proxyInitializedReject?: (error: SwarmIdError) => void

  /**
   * Creates a new SwarmIdClient instance.
   *
   * @param options - Configuration options for the client
   * @param options.iframeOrigin - The origin URL where the Swarm ID proxy iframe is hosted
   * @param options.iframePath - The path to the proxy iframe (defaults to "/proxy")
   * @param options.timeout - Request timeout in milliseconds (defaults to 30000). Bounds each call's whole round trip through the iframe; a call's own `requestOptions.timeout` replaces it for that call
   * @param options.onConnectionChange - Callback invoked when the dApp-visible ConnectionInfo changes (identity, stamp, account type, auth)
   * @param options.popupMode - How to display the authentication popup: "popup" or "window" (defaults to "window")
   * @param options.metadata - Application metadata shown to users during authentication
   * @param options.metadata.name - Application name (1-100 characters)
   * @param options.metadata.description - Optional application description (max 500 characters)
   * @param options.metadata.icon - Optional application icon as a data URL (SVG or PNG, max 4KB)
   * @param options.buttonConfig - Button configuration for the authentication UI (optional)
   * @param options.buttonConfig.connectText - Text for the connect button (optional)
   * @param options.buttonConfig.disconnectText - Text for the disconnect button (optional)
   * @param options.buttonConfig.loadingText - Text shown during loading (optional)
   * @param options.buttonConfig.backgroundColor - Background color for buttons (optional)
   * @param options.buttonConfig.color - Text color for buttons (optional)
   * @param options.buttonConfig.borderRadius - Border radius for buttons and iframe (optional)
   * @param options.buttonConfig.fontFamily - CSS font-family for the button, so it can match the embedding page; a font stack falls back as usual (optional)
   * @param options.buttonConfig.fontSize - CSS font-size for the button; the default floating iframe is a fixed 300x50 px and hides its overflow, so a size that does not fit is clipped — pass `containerId` to own the box (optional)
   * @param options.buttonConfig.fontWeight - CSS font-weight for the button, as a keyword or a number (optional)
   * @param options.containerId - ID of container element to place iframe in (optional)
   * @throws {Error} If constructed where there is no `window` (a server render)
   * @throws {SwarmIdError} `invalid-request` if the provided app metadata is invalid
   */
  constructor(options: ClientOptions) {
    // Before anything touches `window`: a server render reached
    // `setupMessageListener` and threw a bare `ReferenceError` from what, in
    // the published build, is minified code (#778). Name the package and the
    // fix instead.
    if (typeof window === "undefined") {
      throw new Error(
        "@snaha/swarm-id runs in the browser only: construct SwarmIdClient in code that runs there (an effect, onMount, or behind `typeof window !== 'undefined'`), not in a server render",
      )
    }
    this.defaultIframeOrigin = options.iframeOrigin
    this.defaultIframePath = options.iframePath || DEFAULT_IFRAME_PATH
    this.iframeOrigin = this.defaultIframeOrigin
    this.iframePath = this.defaultIframePath
    this.applyIdentitySite(rememberedIdentitySite())
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
    this.initializationTimeout =
      options.initializationTimeout ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
    this.onConnectionChange = options.onConnectionChange
    this.popupMode = options.popupMode || "window"
    this.metadata = options.metadata
    this.buttonConfig = options.buttonConfig
    this.containerId = options.containerId
    this.subsidisedGatewayUrl = options.subsidisedGatewayUrl
    this.permissions = options.permissions

    // Validate metadata and permissions, each named in its own error so a
    // dApp author looks at the right option.
    try {
      AppMetadataSchema.parse(this.metadata)
    } catch (error) {
      throw new SwarmIdError(
        "invalid-request",
        `Invalid app metadata: ${error}`,
        { cause: error },
      )
    }
    try {
      PermissionsSchema.optional().parse(this.permissions)
    } catch (error) {
      throw new SwarmIdError(
        "invalid-request",
        `Invalid permissions: ${error}`,
        { cause: error },
      )
    }

    // Note: `readyPromise`, `proxyInitializedPromise`, and
    // `firstConnectionInfoPromise` (with their timeouts) are all created in
    // `initialize()`, not here — starting the timers at construction would
    // make them expire on consumers that instantiate the client and call
    // `initialize()` later (or never, in tests), and leak an armed timer plus
    // an unguarded rejection in the meantime.

    this.setupMessageListener()
  }

  /**
   * Initializes the client by creating and embedding the proxy iframe.
   *
   * This method must be called before using any other client methods.
   * It creates a hidden iframe, waits for the proxy to initialize,
   * identifies the parent application to the proxy, and waits for
   * the proxy to signal readiness.
   *
   * @returns A promise that resolves when the client is fully initialized
   * @throws {SwarmIdError} `invalid-state` if the client is already initialized, or `destroy()` runs before it resolves
   * @throws {SwarmIdError} `invalid-request` if `containerId` names no element
   * @throws {SwarmIdError} `init-failed` if the iframe fails to load, origin validation fails on the proxy side, or the proxy does not respond within `initializationTimeout` (30 seconds by default)
   *
   * @example
   * ```typescript
   * const client = new SwarmIdClient({ ... })
   * try {
   *   await client.initialize()
   *   console.log('Client ready')
   * } catch (error) {
   *   console.error('Failed to initialize:', error)
   * }
   * ```
   */
  async initialize(): Promise<void> {
    const site = this.iframeOrigin
    try {
      await this.embedProxy()
    } catch (error) {
      // A site the user chose that does not come up — offline, or a version
      // this client cannot talk to (#849): run on the configured site
      // instead, rather than leave the app with nothing. Its remembered
      // preference is not followed straight back, and the choice itself is
      // left for the user to drop on the connect screen.
      if (
        site === this.defaultIframeOrigin ||
        !(error instanceof SwarmIdError) ||
        error.code !== "init-failed"
      ) {
        throw error
      }
      console.warn(
        `[SwarmIdClient] Identity site ${site} did not come up, using ${this.defaultIframeOrigin}:`,
        error.message,
      )
      this.failedSite = site
      this.teardown()
      this.setupMessageListener()
      this.applyIdentitySite(undefined)
      const ignoring = this.ignorePreferredSite
      this.ignorePreferredSite = true
      try {
        await this.embedProxy()
      } finally {
        this.ignorePreferredSite = ignoring
      }
    }
  }

  private async embedProxy(): Promise<void> {
    if (this.iframe) {
      throw new SwarmIdError(
        "invalid-state",
        "SwarmIdClient already initialized",
      )
    }

    // A chosen site gets less time than the app's own: past it `initialize()`
    // falls back to the configured site, and nobody should wait the full
    // deadline for that.
    const deadline =
      this.iframeOrigin === this.defaultIframeOrigin
        ? this.initializationTimeout
        : Math.min(
            this.initializationTimeout,
            CHOSEN_SITE_INITIALIZATION_TIMEOUT_MS,
          )

    // Set up the first-snapshot wait now (not in the constructor) so the
    // timeout starts when initialization actually begins, not when the
    // client object is created. The proxy emits `connectionInfoChanged`
    // unconditionally right after `proxyReady`; we race that against the
    // initializationTimeout so a buggy or version-mismatched proxy can't
    // wedge initialization indefinitely.
    //
    // The `resolve` callback is stashed in an instance field
    // (deferred-style) because it has to be called later, from
    // `handleIframeMessage` when the `connectionInfoChanged` arrives — not
    // from this executor. ES2024's `Promise.withResolvers()` would express
    // the same shape more directly. The `reject` is stashed for `destroy()`.
    this.firstConnectionInfoPromise = initDeadline(
      new Promise<void>((resolve, reject) => {
        this.firstConnectionInfoResolve = resolve
        this.firstConnectionInfoReject = reject
      }),
      deadline,
      `Proxy initialization timeout - proxy did not send initial connectionInfoChanged within ${deadline}ms`,
    )
    // Attach a no-op handler so the rejection isn't surfaced as
    // "unhandled" if the timeout fires before we reach the awaiting line
    // below (e.g. because an earlier `await` in this method hung first).
    // The original promise is still rejected; the `await` at the end of this
    // method re-throws it normally.
    this.firstConnectionInfoPromise.catch(() => {})

    // Same deferred+timeout pattern for the proxyReady handshake and the
    // iframe-ready signal: created here (not the constructor) so the timers
    // start when init begins and `withTimeout` clears them on settle. The
    // stashed resolve/reject are invoked later from `handleIframeMessage`.
    this.proxyInitializedPromise = initDeadline(
      new Promise<void>((resolve, reject) => {
        this.proxyInitializedResolve = resolve
        this.proxyInitializedReject = reject
      }),
      deadline,
      `Proxy initialization timeout - proxy did not signal readiness within ${deadline}ms`,
    )
    this.proxyInitializedPromise.catch(() => {})

    this.readyPromise = initDeadline(
      new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve
        this.readyReject = reject
      }),
      deadline,
      `Proxy initialization timeout - proxy did not respond within ${deadline}ms`,
    )
    this.readyPromise.catch(() => {})

    // Create iframe for proxy
    this.iframe = document.createElement("iframe")
    this.iframe.src = `${this.iframeOrigin}${this.iframePath}`

    // Common iframe styles
    this.iframe.style.border = "none"
    this.iframe.style.backgroundColor = "transparent"
    this.iframe.style.borderRadius = this.buttonConfig?.borderRadius || "0"

    // Determine where to place the iframe
    let containerElement: HTMLElement | undefined
    if (this.containerId) {
      containerElement = document.getElementById(this.containerId) || undefined
      if (!containerElement) {
        throw new SwarmIdError(
          "invalid-request",
          `Container element with ID "${this.containerId}" not found`,
        )
      }

      // Fill the container
      this.iframe.style.width = "100%"
      this.iframe.style.height = "100%"
      this.iframe.style.display = "block"
    } else {
      // Default: fixed position in bottom-right corner (hidden by default)
      this.iframe.style.display = "none"
      this.iframe.style.position = "fixed"
      this.iframe.style.bottom = "20px"
      this.iframe.style.right = "20px"
      this.iframe.style.width = "300px"
      this.iframe.style.height = "50px"
      this.iframe.style.zIndex = "999999"
    }

    // Wait for iframe to load. The `reject` is stashed for `destroy()` while
    // the load is pending: a removed iframe never fires `load`, and nothing
    // else would settle this. Under the deadline too: an unreachable site's
    // iframe may never fire it either (Firefox, connection refused).
    const loaded = new Promise<void>((resolve, reject) => {
      this.iframeLoadReject = reject
      this.iframe!.onload = () => resolve()
      this.iframe!.onerror = () =>
        reject(
          new SwarmIdError("init-failed", "Failed to load Swarm ID iframe"),
        )

      // Append to container or body
      if (containerElement) {
        containerElement.appendChild(this.iframe!)
      } else {
        document.body.appendChild(this.iframe!)
      }
    })
    await initDeadline(
      loaded,
      deadline,
      `Proxy initialization timeout - the iframe did not load within ${deadline}ms`,
    )
    this.iframeLoadReject = undefined

    // Wait for proxy to signal it's ready
    await this.proxyInitializedPromise

    // Identify ourselves to the iframe
    this.sendMessage({
      type: "parentIdentify",
      requestId: this.generateRequestId(),
      popupMode: this.popupMode,
      metadata: this.metadata,
      buttonConfig: this.buttonConfig,
      subsidisedGatewayUrl: this.subsidisedGatewayUrl,
      permissions: this.permissions,
      failedIdentitySite: this.failedSite,
    })

    // Wait for iframe to be ready
    await this.readyPromise

    // The device prefers another site (#849): go there now, so the user's
    // first click already opens that site's popup. Only the proxy's own store
    // can say so, which is why this waits for `proxyReady`.
    const preferred = this.preferredSite
    this.preferredSite = undefined
    if (
      preferred !== undefined &&
      normalizeUrl(preferred) !== this.iframeOrigin &&
      !this.ignorePreferredSite &&
      !this.preferenceFollowed
    ) {
      this.preferenceFollowed = true
      await this.useIdentitySite(preferred)
      return
    }

    // Wait for the initial ConnectionInfo snapshot (sent right after proxyReady)
    // so `client.connectionInfo` is populated by the time `initialize()` resolves.
    await this.firstConnectionInfoPromise
  }

  /**
   * Setup message listener for iframe responses
   */
  private setupMessageListener(): void {
    this.messageListener = (event: MessageEvent) => {
      // Source first, and silently: `window` carries every message the page
      // sends itself — devtools, HMR, wallet extensions — and none of it was
      // addressed to this client, so dropping it is routine rather than a
      // security event and must not reach the console. Before the iframe
      // exists there is no window a message of ours could have come from.
      // This is also what keeps a sibling or parent frame on the identity
      // origin from spoofing a push event like `connectionInfoChanged` or
      // `authSuccess`.
      // The one message the connect popup sends the app page directly: it was
      // opened from here, so its opener is this page, not the iframe (#849).
      if (
        this.authPopup !== null &&
        event.source === this.authPopup &&
        event.origin === new URL(this.iframeOrigin).origin &&
        event.data?.type === "identitySiteChosen"
      ) {
        const chosen = IdentitySiteChosenMessageSchema.safeParse(event.data)
        if (chosen.success) {
          void this.useIdentitySite(chosen.data.site).catch((error) =>
            console.error("[SwarmIdClient] Switching identity site:", error),
          )
        }
        return
      }
      if (!this.iframe || event.source !== this.iframe.contentWindow) {
        return
      }

      // `proxyInitialized` is sent the moment the iframe loads, with a
      // wildcard target origin, so it is answered before the origin check.
      if (event.data?.type === "proxyInitialized") {
        if (this.proxyInitializedResolve) {
          this.proxyInitializedResolve()
          this.proxyInitializedResolve = undefined // Prevent double resolution
        }
        return
      }

      // Our own iframe with an origin other than the configured identity one
      // is worth reporting: the frame is serving something unexpected.
      // (Extract just the origin part, ignoring any path in iframeOrigin.)
      const expectedOrigin = new URL(this.iframeOrigin).origin
      if (event.origin !== expectedOrigin) {
        console.warn(
          "[SwarmIdClient] Rejected message from unauthorized origin:",
          event.origin,
        )
        return
      }

      // Parse and validate message
      let message: IframeToParentMessage
      try {
        message = IframeToParentMessageSchema.parse(event.data)
      } catch (error) {
        console.warn(
          "[SwarmIdClient] Invalid message format:",
          event.data,
          error,
        )
        // Our own proxy's handshake we cannot read: a version this client
        // cannot talk to. Fail now rather than at the deadline.
        if (event.data?.type === "proxyReady") {
          this.readyReject?.(
            new SwarmIdError(
              "init-failed",
              "The identity site runs a version this client cannot talk to",
            ),
          )
        }
        return
      }

      this.handleIframeMessage(message)
    }

    window.addEventListener("message", this.messageListener)
  }

  /**
   * Handle messages from iframe
   */
  private handleIframeMessage(message: IframeToParentMessage): void {
    switch (message.type) {
      case "proxyReady":
        this.ready = true
        // Which transport `connect()` can use, known before the first click
        // (#613). Undefined against a proxy older than that field.
        this.storageShared = message.storageShared
        this.preferredSite = message.identitySite
        this.connectChallenge = message.connectChallenge
        if (this.readyResolve) {
          this.readyResolve()
        }
        // Always show iframe - it will display login or disconnect button
        if (this.iframe) {
          this.iframe.style.display = "block"
        }
        break

      case "authStatusResponse":
        // Always show iframe - it will display login or disconnect button
        if (this.iframe) {
          this.iframe.style.display = "block"
        }
        // Handle as response if there's a matching request
        if ("requestId" in message) {
          const pending = this.pendingRequests.get(message.requestId)
          if (pending) {
            clearTimeout(pending.timeoutId)
            this.pendingRequests.delete(message.requestId)
            pending.resolve(message)
          }
        }
        break

      case "authSuccess":
        // Keep iframe visible - it will now show disconnect button
        if (this.iframe) {
          this.iframe.style.display = "block"
        }
        // Connected on the configured site after the warning (#849): that is
        // the user's answer, so the failed site is not tried again.
        if (this.failedSite !== undefined) {
          this.failedSite = undefined
          try {
            localStorage.removeItem(IDENTITY_SITE_STORAGE_KEY)
          } catch {
            // Storage unavailable: nothing was remembered.
          }
        }
        break

      case "connectionInfoChanged": {
        const info: ConnectionInfo = {
          canUpload: message.canUpload,
          storagePartitioned: message.storagePartitioned,
          uploadMode: message.uploadMode,
          uploadUnavailableReason: message.uploadUnavailableReason,
          deviceId: message.deviceId,
          identity: message.identity,
          appKey: message.appKey,
          partition: message.partition,
          permissions: message.permissions,
          identitySite: this.iframeOrigin,
          failedIdentitySite: this.failedSite,
        }
        this.lastConnectionInfo = info
        if (this.firstConnectionInfoResolve) {
          this.firstConnectionInfoResolve()
          this.firstConnectionInfoResolve = undefined
        }
        if (this.onConnectionChange) {
          this.onConnectionChange(info)
        }
        break
      }

      case "challengeArmed":
        this.connectChallenge = message.challenge
        break

      case "switchIdentitySite":
        // The popup the iframe opened said the user wants another site (#849).
        void this.useIdentitySite(message.site).catch((error) =>
          console.error("[SwarmIdClient] Switching identity site:", error),
        )
        break

      case "initError":
        // Initialization error from proxy (e.g., origin validation failed)
        console.error(
          "[SwarmIdClient] Proxy initialization error:",
          message.error,
        )
        if (this.readyReject) {
          this.readyReject(new SwarmIdError("init-failed", message.error))
        }
        break

      case "disconnectResponse":
        // Handle as response if there's a matching request
        if ("requestId" in message) {
          const pending = this.pendingRequests.get(message.requestId)
          if (pending) {
            clearTimeout(pending.timeoutId)
            this.pendingRequests.delete(message.requestId)
            pending.resolve(message)
          }
        }
        break

      case "error": {
        const pending = this.pendingRequests.get(message.requestId)
        if (pending) {
          clearTimeout(pending.timeoutId)
          this.pendingRequests.delete(message.requestId)
          pending.reject(SwarmIdError.fromWire(message))
        }
        break
      }

      case "uploadProgress":
        // Report to the upload's callback, if it registered one. Don't resolve
        // the pending request - the response does that
        this.progressListeners.get(message.requestId)?.({
          total: message.total,
          processed: message.processed,
        })
        break

      default:
        // Handle response messages with requestId
        if ("requestId" in message) {
          const pending = this.pendingRequests.get(message.requestId)
          if (pending) {
            clearTimeout(pending.timeoutId)
            this.pendingRequests.delete(message.requestId)
            pending.resolve(message)
          }
        }
    }
  }

  /**
   * Send message to iframe
   */
  private sendMessage(message: ParentToIframeMessage): void {
    if (!this.iframe || !this.iframe.contentWindow) {
      throw new SwarmIdError("invalid-state", "Iframe not initialized")
    }

    // Validate message before sending
    try {
      ParentToIframeMessageSchema.parse(message)
    } catch (error) {
      throw new SwarmIdError(
        "invalid-request",
        `Invalid message format: ${error}`,
        { cause: error },
      )
    }

    this.iframe.contentWindow.postMessage(message, this.iframeOrigin)
  }

  /**
   * Send request and wait for response
   */
  private async sendRequest<
    TResponse,
    TRequest extends ParentToIframeMessage & { requestId: string } =
      ParentToIframeMessage & {
        requestId: string
      },
  >(message: TRequest): Promise<TResponse> {
    // A per-call `requestOptions.timeout` bounds this whole round trip, not
    // only the Bee request the proxy makes with it: a caller raising it for a
    // large upload must not be cut off at the constructor default (#775).
    const timeout = this.roundTripTimeout(
      (message as { requestOptions?: RequestOptions }).requestOptions?.timeout,
    )
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(message.requestId)
        reject(
          new SwarmIdError("timeout", `Request timeout after ${timeout}ms`),
        )
      }, timeout)

      this.pendingRequests.set(message.requestId, {
        resolve,
        reject,
        timeoutId,
      })

      this.sendMessage(message)
    })
  }

  /**
   * The round-trip bound for one call, from its own `requestOptions.timeout`.
   *
   * Only a value `setTimeout` can honour is taken. Zero and negatives mean
   * "no timeout" to Bee, which is where this option went before it also bound
   * the round trip — taken literally here they would reject on the next tick,
   * the opposite of what the caller asked, so they fall back to the client
   * default and still reach Bee unchanged. A value past the 32-bit timer
   * ceiling means "as long as it takes", and `setTimeout` would wrap it into
   * firing almost at once, so it clamps to the ceiling instead. `Infinity` and
   * `NaN` never get this far: `z.number()` rejects them on the way out.
   */
  private roundTripTimeout(perCall: number | undefined): number {
    if (perCall === undefined || perCall <= 0) {
      return this.timeout
    }
    return Math.min(perCall, MAX_TIMER_DELAY_MS)
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req-${++this.requestIdCounter}-${Date.now()}`
  }

  private normalizeSocIdentifier(
    identifier: Identifier | Uint8Array | string,
  ): string {
    if (identifier instanceof Identifier) {
      return identifier.toHex()
    }
    if (identifier instanceof Uint8Array) {
      return uint8ArrayToHex(identifier)
    }
    return identifier
  }

  private normalizeSocKey(key: Uint8Array | string): string {
    if (key instanceof Uint8Array) {
      return uint8ArrayToHex(key)
    }
    return key
  }

  private normalizeFeedTopic(
    topic: Topic | Identifier | Uint8Array | string,
  ): string {
    if (topic instanceof Topic) {
      return uint8ArrayToHex(topic.toUint8Array())
    }
    if (topic instanceof Identifier) {
      return topic.toHex()
    }
    if (topic instanceof Uint8Array) {
      return uint8ArrayToHex(topic)
    }
    return topic
  }

  private normalizeReference(reference: Uint8Array | string): string {
    if (reference instanceof Uint8Array) {
      return uint8ArrayToHex(reference)
    }
    return reference
  }

  private normalizeFeedTimestamp(value: bigint | number | string): string {
    if (typeof value === "bigint") {
      return value.toString()
    }
    if (typeof value === "number") {
      return BigInt(Math.floor(value)).toString()
    }
    return value
  }

  private normalizeFeedIndex(value: bigint | number | string): string {
    if (typeof value === "bigint") {
      return value.toString()
    }
    if (typeof value === "number") {
      return BigInt(Math.floor(value)).toString()
    }
    return value
  }

  private normalizePayload(data: Uint8Array | string): Uint8Array {
    if (data instanceof Uint8Array) {
      return data
    }
    return new TextEncoder().encode(data)
  }

  private socChunkFromResponse(response: {
    data: Uint8Array
    identifier: string
    signature: string
    span: number
    payload: Uint8Array
    address: Reference
    owner: string
  }): SingleOwnerChunk {
    return {
      data: response.data,
      identifier: response.identifier,
      signature: response.signature,
      span: response.span,
      payload: response.payload,
      address: response.address,
      owner: response.owner,
    }
  }

  /**
   * Ensure client is initialized
   */
  private ensureReady(): void {
    if (!this.ready) {
      throw new SwarmIdError(
        "invalid-state",
        "SwarmIdClient not initialized. Call initialize() first.",
      )
    }
  }

  // ============================================================================
  // Authentication Methods
  // ============================================================================

  /**
   * Returns the authentication iframe element.
   *
   * The iframe displays authentication UI based on the current auth status:
   * - If not authenticated: shows a "Connect" button
   * - If authenticated: shows identity info and a "Disconnect" button
   *
   * The iframe is positioned fixed in the bottom-right corner of the viewport.
   *
   * @returns The iframe element displaying the authentication UI
   * @throws {SwarmIdError} `invalid-state` if the client is not initialized, or the iframe is not available
   *
   * @example
   * ```typescript
   * const iframe = client.getAuthIframe()
   * // The iframe is already displayed; this returns a reference to it
   * ```
   */
  getAuthIframe(): HTMLIFrameElement {
    this.ensureReady()

    if (!this.iframe) {
      throw new SwarmIdError("invalid-state", "Iframe not initialized")
    }

    return this.iframe
  }

  /**
   * Checks the current authentication status with the Swarm ID proxy.
   *
   * @returns A promise resolving to the authentication status object
   * @returns return.authenticated - Whether the user is currently authenticated
   * @returns return.origin - The origin that authenticated (if authenticated)
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const status = await client.checkAuthStatus()
   * if (status.authenticated) {
   *   console.log('Authenticated from:', status.origin)
   * }
   * ```
   */
  async checkAuthStatus(): Promise<AuthStatus> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "authStatusResponse"
      requestId: string
      authenticated: boolean
      origin?: string
      beeApiUrl?: string
    }>({
      type: "checkAuth",
      requestId,
    })

    return {
      authenticated: response.authenticated,
      origin: response.origin,
      beeApiUrl: response.beeApiUrl,
    }
  }

  /**
   * Gets the current postage batch for the authenticated identity.
   *
   * Returns information about the postage stamp associated with the
   * connected identity, including batch ID, utilization, depth, and TTL.
   *
   * @returns A promise resolving to the PostageBatch or undefined if none is configured
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const batch = await client.getPostageBatch()
   * if (batch) {
   *   console.log('Batch ID:', batch.batchID)
   *   console.log('Utilization:', batch.utilization)
   *   console.log('Depth:', batch.depth)
   *   console.log('TTL:', batch.batchTTL)
   * } else {
   *   console.log('No postage batch configured')
   * }
   * ```
   */
  async getPostageBatch(): Promise<PostageBatch | undefined> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "getPostageBatchResponse"
      requestId: string
      postageBatch?: PostageBatch
    }>({
      type: "getPostageBatch",
      requestId,
    })

    return response.postageBatch
  }

  /**
   * The drives this app was granted (#862): each with the fields of
   * {@link getPostageBatch}, its `kind`, and whether it is the primary — the
   * one a write goes to when it names none. Name any of them on a write with
   * `batchID`; one outside the grant rejects with `drive-not-granted`.
   *
   * @example
   * ```typescript
   * const scratch = (await client.getDrives()).find((d) => d.kind === 'scratch')
   * await client.uploadData(frame, { batchID: scratch?.batchID })
   * ```
   */
  async getDrives(): Promise<Drive[]> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "getDrivesResponse"
      requestId: string
      drives: Drive[]
    }>({
      type: "getDrives",
      requestId,
    })

    return response.drives
  }

  /**
   * Disconnects the current session and clears authentication data.
   *
   * After disconnection, the user will need to re-authenticate to perform
   * uploads or access identity-related features. The
   * {@link ClientOptions.onConnectionChange} callback will fire with an
   * un-authenticated snapshot.
   *
   * @returns A promise that resolves when disconnection is complete
   * @throws {SwarmIdError} `invalid-state` if the client is not initialized
   * @throws {SwarmIdError} `internal` if the proxy reports the disconnect failed
   * @throws {SwarmIdError} `timeout` if the request times out
   *
   * @example
   * ```typescript
   * await client.disconnect()
   * console.log('User logged out')
   * ```
   */
  async disconnect(): Promise<void> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "disconnectResponse"
      requestId: string
      success: boolean
    }>({
      type: "disconnect",
      requestId,
    })

    if (!response.success) {
      throw new SwarmIdError("internal", "Failed to disconnect")
    }
  }

  /**
   * Opens the Swarm ID authentication page in a new window.
   *
   * This method creates the same authentication URL as used by the iframe
   * proxy and opens it in a new browser window. The user can authenticate
   * with their Swarm ID, and the resulting authentication will be available
   * to the client when they return.
   *
   * It is always opened here, synchronously, inside the user's click —
   * Firefox refuses an iframe a popup on the parent's click (#751). **How the
   * session gets back** is decided by the iframe's STORAGE, not by the user
   * agent (#613):
   * - Shared storage: the popup writes the connection to the first-party store
   *   the iframe reads, and a `storage` event carries it across.
   * - Partitioned, or not proven shared: the popup carries the challenge the
   *   proxy armed ahead of the click, and posts the session to the iframe
   *   among this page's frames — the only channel into a partitioned frame.
   *   The session is then kept in that partition's own store until it is
   *   disconnected or its 30 days are up (#635), so a reload does not re-run
   *   this; a handover that arrives without the account view is refused
   *   outright rather than producing a session that cannot upload and cannot
   *   hear a revoke.
   *
   * Safari private mode sessions are ephemeral (lost when the private window
   * closes). The whole partitioned path — handover, stamper, upload — is
   * confirmed on real Safari; see
   * https://github.com/snaha/swarm-id/issues/584
   *
   * @param options - Configuration options for the connect flow
   * @throws {SwarmIdError} `invalid-state` if the client is not initialized
   * @throws {SwarmIdError} `popup-blocked` if the browser blocks the popup
   *
   * @example
   * ```typescript
   * const client = new SwarmIdClient({ ... })
   * await client.initialize()
   *
   * // Open authentication page
   * await client.connect()
   * ```
   */
  async connect(options: ConnectOptions = {}): Promise<void> {
    this.ensureReady()

    // Opened here, inside the user's click: Firefox refuses an iframe a
    // popup on the parent's click (#751), and no page may open one after an
    // await. Storage shared: the popup writes the connection to the
    // first-party store the iframe reads, and a `storage` event carries it
    // across. Otherwise the popup carries the challenge the proxy armed ahead
    // of the click, and hands the session to the iframe among this page's
    // frames — which works in both storage modes.
    const challenge =
      this.storageShared === true ? undefined : this.connectChallenge
    // Checked, not discarded: a blocked popup opens nothing, and a `connect()`
    // that resolved anyway would report a connect in progress that no window
    // is running.
    if (!this.openAuthWindow(options, challenge)) {
      throw new SwarmIdError(
        "popup-blocked",
        "Failed to open authentication popup",
      )
    }
  }

  /**
   * Ask the user for more drives (#711). Opens the "Permissions for <app>"
   * popup showing only what is asked; the user picks drives, may create one,
   * or grants nothing. Resolves once the popup is closed with the drives the
   * app now holds — the same as before when the user granted nothing or
   * closed it. Call it from a user gesture, as `connect()`: a popup opened
   * later is blocked.
   *
   * @example
   * ```typescript
   * const drives = await client.requestDrives([{ kind: 'scratch' }])
   * const scratch = drives.find((drive) => drive.kind === 'scratch')
   * ```
   * @throws {SwarmIdError} `not-authenticated` when the app is not connected
   * @throws {SwarmIdError} `popup-blocked` when the browser blocked the popup
   */
  async requestDrives(drives: DriveRequest): Promise<Drive[]> {
    this.ensureReady()
    await this.openPermissions({ drives })
    return this.getDrives()
  }

  /**
   * What this app may do with the account-wide sharing key (#885): read what
   * was shared with it (`dataSharing`), and publish or manage shares as the
   * identity (`writeAccess`). Both are on unless the user switched them off,
   * for every app or for this one. A call that needs one that is off rejects
   * with `permission-denied`; check here first to ask the user before that
   * happens. The same two booleans ride `connectionInfo.permissions`.
   *
   * @example
   * ```typescript
   * if (!(await client.getPermissions()).dataSharing) {
   *   await client.requestPermissions({ dataSharing: true })
   * }
   * ```
   */
  async getPermissions(): Promise<AppPermissions> {
    this.ensureReady()
    const response = await this.sendRequest<{
      type: "getPermissionsResponse"
      requestId: string
      permissions: AppPermissions
    }>({
      type: "getPermissions",
      requestId: this.generateRequestId(),
    })
    return response.permissions
  }

  /**
   * Ask the user for more (#711, #885): drives, and the two sharing switches.
   * Opens the "Permissions for <app>" popup showing only what is asked —
   * each drive row empty, each switch off — and resolves once it is closed
   * with what the app holds, granted or not; a closed popup grants nothing.
   * When every switch asked for is already on and no drives were asked for,
   * nothing is opened. Call it from a user gesture, as `connect()`.
   *
   * {@link requestDrives} is the drives-only form.
   *
   * @example
   * ```typescript
   * const { dataSharing } = await client.requestPermissions({ dataSharing: true })
   * if (!dataSharing) return showSharedInboxUnavailable()
   * ```
   * @throws {SwarmIdError} `not-authenticated` when the app is not connected
   * @throws {SwarmIdError} `popup-blocked` when the browser blocked the popup
   */
  async requestPermissions(permissions: Permissions): Promise<AppPermissions> {
    this.ensureReady()
    const held = this.lastConnectionInfo?.permissions
    const satisfied =
      permissions.drives === undefined &&
      (!permissions.dataSharing || held?.dataSharing === true) &&
      (!permissions.writeAccess || held?.writeAccess === true)
    if (!satisfied) await this.openPermissions(permissions)
    return this.getPermissions()
  }

  /**
   * Opened the way `connect()` opens: from the parent while the iframe's
   * store is shared, which keeps the click; otherwise by the iframe, so a
   * partitioned session is handed the new grant directly.
   */
  private async openPermissions(permissions: Permissions): Promise<void> {
    const account = this.lastConnectionInfo?.identity?.id
    if (!account) {
      throw new SwarmIdError(
        "not-authenticated",
        "Connect to Swarm ID before asking for more permissions.",
      )
    }
    if (this.storageShared !== true) {
      const response = await this.sendRequest<{
        type: "requestPermissionsResponse"
        requestId: string
        opened: boolean
      }>({
        type: "requestPermissions",
        requestId: this.generateRequestId(),
        permissions,
        popupMode: this.popupMode,
        requestOptions: { timeout: PERMISSIONS_REQUEST_TIMEOUT_MS },
      })
      if (response.opened) return
    }
    const basePath = this.iframePath.replace(/\/proxy$/, "")
    const url = buildAuthUrl(
      this.iframeOrigin + basePath,
      window.location.origin,
      this.metadata,
      {
        permissions,
        permissionsFor: account,
        // Opened here although the iframe could not see shared storage (its
        // own popup was blocked): the bus is the only way back to it.
        handOverViaBus: this.storageShared !== true,
      },
    )
    const popup =
      this.popupMode === "popup"
        ? window.open(url, "_blank", "width=500,height=600")
        : window.open(url, "_blank")
    if (!popup) {
      throw new SwarmIdError(
        "popup-blocked",
        "Failed to open the permissions popup",
      )
    }
    await untilPopupClosed(popup, PERMISSIONS_POPUP_MAX_MS)
  }

  /**
   * Open the auth popup from the dApp page.
   *
   * Without a challenge the popup's handover has nothing to attach to, and it
   * relies on the storage write it does anyway — right when the store is
   * shared. With the proxy's challenge, the popup also posts the session to
   * this page's frames, which is how a partitioned iframe gets it when the
   * browser would not let the iframe open the popup itself (#751).
   *
   * @returns whether the popup opened — a blocked one returns null, which the
   *   caller must not report as a connect in progress.
   */
  private openAuthWindow(options: ConnectOptions, challenge?: string): boolean {
    const basePath = this.iframePath.replace(/\/proxy$/, "")
    const authUrl = buildAuthUrl(
      this.iframeOrigin + basePath,
      window.location.origin,
      this.metadata,
      { permissions: this.permissions, challenge, failedSite: this.failedSite },
    )

    const effectivePopupMode = options.popupMode ?? this.popupMode
    const popup =
      effectivePopupMode === "popup"
        ? window.open(authUrl, "_blank", "width=500,height=600")
        : window.open(authUrl, "_blank")
    this.authPopup = popup
    return Boolean(popup)
  }

  /**
   * Base URL of the identity site this client runs against (#849): the
   * configured `iframeOrigin`, or the one the user chose on the connect screen,
   * remembered in this origin's storage.
   */
  get identitySite(): string {
    return this.iframeOrigin
  }

  /**
   * Run against another identity site (#849), or `undefined` for the app's
   * own again: remembers the choice for this app origin, tears the proxy
   * iframe down and embeds one from the chosen site. The user then connects
   * there — through the new iframe's own button, since no click is left to
   * open a popup with.
   *
   * @throws {SwarmIdError} `invalid-request` when `site` is not an http(s) URL
   */
  async useIdentitySite(site: string | undefined): Promise<void> {
    const base = site === undefined ? undefined : normalizeUrl(site)
    if (base !== undefined && !isHttpUrl(base)) {
      throw new SwarmIdError(
        "invalid-request",
        `Identity site is not an http(s) URL: ${site}`,
      )
    }
    // A new choice: whether it comes up is for this initialize to find out.
    this.failedSite = undefined
    try {
      if (base === undefined) {
        localStorage.removeItem(IDENTITY_SITE_STORAGE_KEY)
      } else {
        localStorage.setItem(IDENTITY_SITE_STORAGE_KEY, base)
      }
    } catch {
      // Storage unavailable: the choice holds for this page load only.
    }
    this.applyIdentitySite(base)
    this.teardown()
    this.setupMessageListener()
    // A reset must not be undone by the default site remembering the choice:
    // the preference is skipped for this one initialize, then cleared where
    // the default's proxy can reach it (its first-party store when shared;
    // a partitioned store holds nothing to clear, and the popup offers the
    // remembered site with a way to decline it).
    this.ignorePreferredSite = base === undefined
    try {
      await this.initialize()
    } finally {
      this.ignorePreferredSite = false
    }
    if (base === undefined) {
      await this.sendRequest({
        type: "clearIdentitySite",
        requestId: this.generateRequestId(),
      })
    }
  }

  /**
   * A chosen site is a base URL that carries its own path, so the proxy is at
   * `/proxy` under it; the configured `iframePath` belongs to the default only.
   */
  private applyIdentitySite(base: string | undefined): void {
    this.iframeOrigin = base ?? this.defaultIframeOrigin
    this.iframePath =
      base === undefined ? this.defaultIframePath : DEFAULT_IFRAME_PATH
  }

  /**
   * Current dApp-visible {@link ConnectionInfo} snapshot — identity, app key,
   * upload capability, and upload mode. Populated by the proxy as soon as it
   * is ready and refreshed whenever any of those derived fields change.
   * Subscribe to {@link ClientOptions.onConnectionChange} to react to updates.
   *
   * @throws {SwarmIdError} `invalid-state` if {@link initialize} has not resolved yet
   *
   * @example
   * ```typescript
   * await client.initialize()
   * const info = client.connectionInfo
   * if (info.canUpload) {
   *   console.log('Ready to upload as:', info.identity?.name)
   * }
   * ```
   */
  get connectionInfo(): ConnectionInfo {
    this.ensureReady()
    if (!this.lastConnectionInfo) {
      // `ready` flips true on `proxyReady`, which the proxy sends before its
      // first `connectionInfoChanged`, so a read before `initialize()`
      // resolves can land here.
      throw new SwarmIdError(
        "invalid-state",
        "SwarmIdClient connectionInfo not yet available.",
      )
    }
    return this.lastConnectionInfo
  }

  /**
   * Avatar of the connected identity at a specific size.
   *
   * Most callers want `connectionInfo.identity.avatar` instead — it is already
   * resolved on every snapshot and needs no call. Reach for this only to
   * render at a size the default does not suit. Async so that honouring a size
   * may involve fetching, which anything but the generated avatar would.
   *
   * @param options.size - Width and height in pixels
   * @returns The avatar, or `undefined` when no identity is connected
   */
  async getAvatar(
    options: { size?: number } = {},
  ): Promise<Avatar | undefined> {
    const { identity } = this.connectionInfo
    if (!identity) {
      return undefined
    }
    // Only a generated avatar can be re-rendered from the id; any other kind
    // is served as-is.
    return options.size !== undefined && identity.avatar.source === "generated"
      ? generatedAvatar(identity.id, options.size)
      : identity.avatar
  }

  // ============================================================================
  // Bee Connectivity Methods
  // ============================================================================

  /**
   * Checks whether the Bee node is reachable.
   *
   * This method never throws an exception. If the client is not initialized,
   * the request times out, or any other error occurs, it returns `false`.
   *
   * @returns A promise resolving to `true` if the Bee node is reachable, `false` otherwise
   *
   * @example
   * ```typescript
   * const connected = await client.isBeeConnected()
   * if (connected) {
   *   console.log('Bee node is online')
   * } else {
   *   console.log('Bee node is offline')
   * }
   * ```
   */
  async isBeeConnected(): Promise<boolean> {
    try {
      this.ensureReady()
      const requestId = this.generateRequestId()

      const response = await this.sendRequest<{
        type: "isConnectedResponse"
        requestId: string
        connected: boolean
      }>({
        type: "isConnected",
        requestId,
      })

      return response.connected
    } catch {
      return false
    }
  }

  /**
   * Gets information about the Bee node configuration.
   *
   * Needs a real Bee node: the public gateway has no `/node` endpoint, so this
   * rejects there. Do not gate uploads on it — it exists to detect a dev-mode
   * node, where deferred uploads are required.
   *
   * This method retrieves the current Bee node's operating mode and feature flags.
   * Use this to determine if deferred uploads are required (dev mode) or if direct
   * uploads are available (production modes).
   *
   * @returns A promise resolving to the node info object
   * @returns return.beeMode - The Bee node operating mode ("dev", "light", "full", "ultra-light")
   * @returns return.chequebookEnabled - Whether the chequebook is enabled
   * @returns return.swapEnabled - Whether SWAP is enabled
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the Bee node is not reachable
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const nodeInfo = await client.getNodeInfo()
   * if (nodeInfo.beeMode === 'dev') {
   *   // Dev mode requires deferred uploads
   *   await client.uploadData(data, { deferred: true })
   * } else {
   *   // Production modes can use direct uploads
   *   await client.uploadData(data, { deferred: false })
   * }
   * ```
   */
  async getNodeInfo(): Promise<{
    beeMode: string
    chequebookEnabled: boolean
    swapEnabled: boolean
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "getNodeInfoResponse"
      requestId: string
      beeMode: string
      chequebookEnabled: boolean
      swapEnabled: boolean
    }>({
      type: "getNodeInfo",
      requestId,
    })

    return {
      beeMode: response.beeMode,
      chequebookEnabled: response.chequebookEnabled,
      swapEnabled: response.swapEnabled,
    }
  }

  // ============================================================================
  // Data Upload/Download Methods
  // ============================================================================

  /**
   * Uploads raw binary data to the Swarm network.
   *
   * Read the returned reference back with {@link downloadData}, or from a
   * gateway at `/bytes/<reference>`. It carries no manifest, so
   * {@link downloadFile} and `/bzz/` cannot resolve it.
   *
   * The data is uploaded using the authenticated user's postage stamp.
   * Progress can be tracked via the optional callback.
   *
   * @param data - The binary data to upload as a Uint8Array
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the data locally (defaults to false; ignored on a subsidised gateway)
   * @param options.encrypt - Whether to encrypt the data (defaults to false)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param options.onProgress - Optional callback for tracking upload progress
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference (hash) of the uploaded data
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const data = new TextEncoder().encode('Hello, Swarm!')
   * const result = await client.uploadData(data, {
   *   encrypt: true,
   *   onProgress: (progress) => {
   *     console.log(`Progress: ${progress.processed}/${progress.total}`)
   *   },
   * })
   * console.log('Reference:', result.reference)
   * ```
   */
  async uploadData(
    data: Uint8Array,
    options?: UploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const {
      onProgress,
      useWebSocket,
      useWorkers,
      workerCount,
      concurrency,
      ...serializableOptions
    } = options ?? {}

    const stopProgress = this.listenForProgress(requestId, onProgress)
    try {
      const response = await this.sendRequest<{
        type: "uploadDataResponse"
        requestId: string
        reference: Reference
        tagUid?: number
      }>({
        type: "uploadData",
        requestId,
        data: new Uint8Array(data),
        options: serializableOptions,
        requestOptions,
        enableProgress: !!onProgress,
        useWebSocket,
        useWorkers,
        workerCount,
        concurrency,
      })

      return {
        reference: response.reference,
        tagUid: response.tagUid,
      }
    } finally {
      stopProgress()
    }
  }

  /**
   * Downloads raw binary data from the Swarm network: the counterpart of
   * {@link uploadData}. Pass an encrypted (128-hex) reference here rather
   * than putting it in a gateway URL — it contains the decryption key.
   *
   * @param reference - The Swarm reference (hash) of the data to download.
   *                    Can be 64 hex chars (32 bytes) or 128 hex chars (64 bytes for encrypted)
   * @param options - Optional download configuration
   * @param options.redundancyStrategy - Strategy for handling redundancy (0-3)
   * @param options.fallback - Whether to use fallback retrieval
   * @param options.timeoutMs - Download timeout in milliseconds
   * @param options.actPublisher - ACT publisher for encrypted content
   * @param options.actHistoryAddress - ACT history address for encrypted content
   * @param options.actTimestamp - ACT timestamp for encrypted content
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the downloaded data as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const data = await client.downloadData('a1b2c3...') // 64 char hex reference
   * const text = new TextDecoder().decode(data)
   * console.log('Downloaded:', text)
   * ```
   */
  async downloadData(
    reference: Reference,
    options?: DownloadOptions,
    requestOptions?: RequestOptions,
  ): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "downloadDataResponse"
      requestId: string
      data: Uint8Array
    }>({
      type: "downloadData",
      requestId,
      reference,
      options,
      requestOptions,
    })

    return response.data
  }

  /**
   * Derive a stable, app-scoped secret for this identity + app origin.
   *
   * Computes `HMAC(appSecret, label)` inside the iframe, where `appSecret` is the
   * app-specific secret that never leaves the trusted context. The result is
   * deterministic — the same identity, app origin, and label always yield the
   * same bytes across sessions and devices — yet unguessable to anyone without
   * the identity. Use it to seed feed topics or other app material without
   * exposing the recoverable app public key (#520).
   *
   * @param label - Application-chosen domain separator (e.g. `"state-feed"`)
   * @returns A promise resolving to the 32-byte derived secret
   * @throws {Error} If the client is not initialized or not authenticated
   *
   * @example
   * ```typescript
   * const seed = await client.deriveAppSecret('state-feed')
   * const topic = keccak256(seed) // an unguessable, stable feed topic
   * ```
   */
  async deriveAppSecret(label: string): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "deriveAppSecretResponse"
      requestId: string
      secret: Uint8Array
    }>({
      type: "deriveAppSecret",
      requestId,
      label,
    })

    return response.secret
  }

  // ============================================================================
  // File Upload/Download Methods
  // ============================================================================

  /**
   * Uploads a file to the Swarm network, wrapped in a manifest that carries
   * its name and content type. Read the reference back with
   * {@link downloadFile}. A gateway's `/bzz/<reference>/` is only for a plain
   * reference, uploaded with `encrypt: false`.
   *
   * Accepts either a File object (from file input) or raw Uint8Array data.
   * When using a File object, the filename is automatically extracted unless
   * explicitly overridden.
   *
   * Content is encrypted unless `options.encrypt` is `false`, and the
   * manifest too — a 64-byte reference that carries the key — unless
   * `options.encrypt` or `options.encryptManifest` is `false`. The same rule
   * as {@link uploadFiles}.
   *
   * @param file - The file to upload (File object or Uint8Array)
   * @param name - Optional filename (extracted from File object if not provided)
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the file locally (defaults to false; ignored on a subsidised gateway)
   * @param options.encrypt - Whether to encrypt the file content (defaults to true); `false` also leaves the manifest plain
   * @param options.encryptManifest - Whether to encrypt the manifest too (defaults to true); `false` gives a 32-byte reference over encrypted content
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference (hash) of the uploaded file
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // From file input
   * const fileInput = document.querySelector('input[type="file"]')
   * const file = fileInput.files[0]
   * const result = await client.uploadFile(file)
   *
   * // From Uint8Array with custom name
   * const data = new Uint8Array([...])
   * const result = await client.uploadFile(data, 'document.pdf')
   * ```
   */
  async uploadFile(
    file: File | Uint8Array,
    name?: string,
    options?: UploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const {
      onProgress,
      useWebSocket,
      useWorkers,
      workerCount,
      concurrency,
      ...serializableOptions
    } = options ?? {}

    let data: Uint8Array
    let fileName: string | undefined = name

    if (file instanceof File) {
      const buffer = await file.arrayBuffer()
      data = new Uint8Array(buffer)
      fileName = fileName || file.name
    } else {
      data = new Uint8Array(
        file.buffer.slice(0),
        file.byteOffset,
        file.byteLength,
      )
    }

    const stopProgress = this.listenForProgress(requestId, onProgress)
    try {
      const response = await this.sendRequest<{
        type: "uploadFileResponse"
        requestId: string
        reference: Reference
        tagUid?: number
      }>({
        type: "uploadFile",
        requestId,
        data,
        name: fileName,
        options: serializableOptions,
        requestOptions,
        enableProgress: !!onProgress,
        useWebSocket,
        useWorkers,
        workerCount,
        concurrency,
      })

      return {
        reference: response.reference,
        tagUid: response.tagUid,
      }
    } finally {
      stopProgress()
    }
  }

  /**
   * Downloads a file from the Swarm network: the counterpart of
   * {@link uploadFile}. It resolves a manifest, so a reference produced by
   * {@link uploadData} fails here inside the manifest parser; use
   * {@link downloadData} for those.
   *
   * Returns both the file data and its original filename (if available).
   * For manifest references, an optional path can be specified to retrieve
   * a specific file from the manifest.
   *
   * @param reference - The Swarm reference (hash) of the file to download
   * @param path - Optional path within a manifest to retrieve a specific file
   * @param options - Optional download configuration
   * @param options.redundancyStrategy - Strategy for handling redundancy (0-3)
   * @param options.fallback - Whether to use fallback retrieval
   * @param options.timeoutMs - Download timeout in milliseconds
   * @param options.actPublisher - ACT publisher for encrypted content
   * @param options.actHistoryAddress - ACT history address for encrypted content
   * @param options.actTimestamp - ACT timestamp for encrypted content
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the file data object
   * @returns return.name - The filename
   * @returns return.data - The file contents as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const file = await client.downloadFile('a1b2c3...')
   * console.log('Filename:', file.name)
   *
   * // Create download link
   * const blob = new Blob([file.data])
   * const url = URL.createObjectURL(blob)
   * ```
   */
  async downloadFile(
    reference: Reference,
    path?: string,
    options?: DownloadOptions,
    requestOptions?: RequestOptions,
  ): Promise<FileData> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "downloadFileResponse"
      requestId: string
      name: string
      data: number[]
    }>({
      type: "downloadFile",
      requestId,
      reference,
      path,
      options,
      requestOptions,
    })

    return {
      name: response.name,
      data: new Uint8Array(response.data),
    }
  }

  /**
   * Uploads a folder as one manifest (#750): a fork per file with its path and
   * content type, which a gateway serves at `/bzz/<reference>/<path>` when the
   * folder is plain (`encrypt: false`). Takes what bee-js takes — the
   * `FileList` of a `webkitdirectory` input or a dropped directory, a `File[]`,
   * or `{ path, file }` pairs for a folder the app assembled itself. A `File`'s
   * path is its `webkitRelativePath` minus the picked folder's own name, or its
   * name.
   *
   * Content is encrypted unless `options.encrypt` is `false`, and the
   * manifest too — a 64-byte root reference — unless `options.encrypt` or
   * `options.encryptManifest` is `false`. Name `options.indexDocument` for
   * the bare `/bzz/<reference>/` to serve a file. Read a folder back with
   * {@link listFiles} and {@link downloadData} per entry, or one file with
   * {@link downloadFile} and its path.
   *
   * Every file is read into memory before the upload starts; for folders
   * larger than that, upload the files with {@link uploadData} and build the
   * manifest with `@ethersphere/core-sdk`.
   *
   * @param files - The folder's files
   * @param options - Optional upload configuration; `onProgress` counts files, `useWorkers` / `workerCount` stamp in a pool as with {@link uploadData}
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference of the manifest
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If two files share a path
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // <input type="file" webkitdirectory>
   * const { reference } = await client.uploadFiles(input.files, {
   *   indexDocument: 'index.html',
   * })
   * // or assembled by the app
   * await client.uploadFiles([{ path: 'a/b.txt', file: new Blob(['hi']) }])
   * ```
   */
  async uploadFiles(
    files: FileList | Iterable<File | CollectionFileInput>,
    options?: UploadFilesOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress, useWorkers, workerCount, ...serializableOptions } =
      options ?? {}

    const entries = await Promise.all(
      Array.from(files, async (item) => {
        const { path, file } =
          item instanceof File
            ? { path: collectionPath(item), file: item }
            : item
        return {
          path,
          data: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type || undefined,
        }
      }),
    )

    const stopProgress = this.listenForProgress(requestId, onProgress)
    try {
      const response = await this.sendRequest<{
        type: "uploadFilesResponse"
        requestId: string
        reference: Reference
        tagUid?: number
      }>({
        type: "uploadFiles",
        requestId,
        files: entries,
        options: serializableOptions,
        requestOptions,
        enableProgress: !!onProgress,
        useWorkers,
        workerCount,
      })
      return { reference: response.reference, tagUid: response.tagUid }
    } finally {
      stopProgress()
    }
  }

  /**
   * Lists the files of a manifest uploaded with {@link uploadFiles} (or any
   * manifest): each entry's path, content type, and the reference of its
   * content, which {@link downloadData} reads.
   *
   * @param reference - The Swarm reference of the manifest
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry)
   * @returns A promise resolving to the entries, the index-document fork excluded
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not a manifest or is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * for (const { path, reference } of await client.listFiles(root)) {
   *   const data = await client.downloadData(reference)
   * }
   * ```
   */
  async listFiles(
    reference: Reference,
    requestOptions?: RequestOptions,
  ): Promise<CollectionEntry[]> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const response = await this.sendRequest<{
      type: "listFilesResponse"
      requestId: string
      entries: CollectionEntry[]
    }>({ type: "listFiles", requestId, reference, requestOptions })
    return response.entries
  }

  /**
   * Forward the proxy's `uploadProgress` messages for one request to a
   * callback, through the window listener's checks. Returns the function that
   * stops forwarding; a no-op without a callback.
   */
  private listenForProgress(
    requestId: string,
    onProgress: ((progress: UploadProgress) => void) | undefined,
  ): () => void {
    if (!onProgress) return () => {}
    this.progressListeners.set(requestId, onProgress)
    return () => {
      this.progressListeners.delete(requestId)
    }
  }

  // ============================================================================
  // Chunk Upload/Download Methods
  // ============================================================================

  /**
   * Uploads a single chunk to the Swarm network.
   *
   * Chunks are the fundamental unit of storage in Swarm (4KB each).
   * This method is useful for low-level operations or when implementing
   * custom chunking strategies.
   *
   * `data` is the chunk's payload, not a finished chunk: the proxy builds the
   * content-addressed chunk around it (span header, BMT address) and returns
   * that address. A chunk that already carries its span header is wrapped a
   * second time and stored under an address nothing else computes (#774). To
   * store a folder as a manifest, use {@link uploadFiles}; to save a Mantaray
   * tree of your own, use `saveMantarayTreeRecursively` with {@link uploadData}.
   *
   * @param data - The chunk payload, 1 to 4096 bytes
   * @param options - Optional upload configuration
   * @param options.pin - Whether to pin the chunk locally (defaults to false; ignored on a subsidised gateway)
   * @param options.encrypt - Whether to encrypt the chunk (defaults to false)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the upload result
   * @returns return.reference - The Swarm reference (hash) of the uploaded chunk
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const chunk = new Uint8Array(4096) // 4KB chunk
   * chunk.fill(0x42) // Fill with data
   * const result = await client.uploadChunk(chunk)
   * console.log('Chunk reference:', result.reference)
   * ```
   */
  async uploadChunk(
    data: Uint8Array,
    options?: UploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress: _onProgress, ...serializableOptions } = options ?? {}

    const response = await this.sendRequest<{
      type: "uploadChunkResponse"
      requestId: string
      reference: Reference
    }>({
      type: "uploadChunk",
      requestId,
      data: data as Uint8Array,
      options: serializableOptions,
      requestOptions,
    })

    return {
      reference: response.reference,
    }
  }

  /**
   * Downloads a single chunk from the Swarm network.
   *
   * Retrieves a chunk by its reference hash. This method is useful for
   * low-level operations or when implementing custom retrieval strategies.
   *
   * @param reference - The Swarm reference (hash) of the chunk to download
   * @param options - Optional download configuration
   * @param options.redundancyStrategy - Strategy for handling redundancy (0-3)
   * @param options.fallback - Whether to use fallback retrieval
   * @param options.timeoutMs - Download timeout in milliseconds
   * @param options.actPublisher - ACT publisher for encrypted content
   * @param options.actHistoryAddress - ACT history address for encrypted content
   * @param options.actTimestamp - ACT timestamp for encrypted content
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the chunk data as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the reference is not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const chunk = await client.downloadChunk('a1b2c3...')
   * console.log('Chunk size:', chunk.length)
   * ```
   */
  async downloadChunk(
    reference: Reference,
    options?: DownloadOptions,
    requestOptions?: RequestOptions,
  ): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "downloadChunkResponse"
      requestId: string
      data: number[]
    }>({
      type: "downloadChunk",
      requestId,
      reference,
      options,
      requestOptions,
    })

    return new Uint8Array(response.data)
  }

  // ============================================================================
  // SOC (Single Owner Chunk) Methods
  // ============================================================================

  /**
   * Returns an object for reading single owner chunks (SOC).
   *
   * @param ownerAddress - Ethereum address of the SOC owner
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns SOCReader with `download` (encrypted) and `rawDownload` (unencrypted)
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const reader = client.makeSOCReader(owner)
   * const soc = await reader.download(identifier, encryptionKey)
   * console.log('Payload:', new TextDecoder().decode(soc.payload))
   * ```
   */
  makeSOCReader(
    ownerAddress: EthAddress | Uint8Array | string,
    requestOptions?: RequestOptions,
  ): SOCReader {
    this.ensureReady()
    const owner = new EthAddress(ownerAddress).toHex()

    const sendSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocDownloadResponseMessage,
        SocDownloadMessage
      >({
        type: "socDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    const sendRawSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey?: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocRawDownloadResponseMessage,
        SocRawDownloadMessage
      >({
        type: "socRawDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: encryptionKey
          ? this.normalizeSocKey(encryptionKey)
          : undefined,
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    return {
      getOwner: async () => owner,
      rawDownload: (identifier, encryptionKey) =>
        sendRawSocDownload(identifier, encryptionKey),
      download: (identifier, encryptionKey) =>
        sendSocDownload(identifier, encryptionKey),
    }
  }

  /**
   * Returns an object for reading and writing single owner chunks (SOC).
   *
   * Uploads are encrypted by default. Use `rawUpload` for unencrypted SOCs.
   *
   * @param signer - Optional SOC signer private key. If omitted, the proxy uses the app signer.
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns SOCWriter with `upload`, `rawUpload`, `download`, and `rawDownload`
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const writer = client.makeSOCWriter()
   * const upload = await writer.upload(identifier, payload)
   * const soc = await writer.download(identifier, upload.encryptionKey)
   * ```
   */
  makeSOCWriter(
    signer?: PrivateKey | Uint8Array | string,
    requestOptions?: RequestOptions,
  ): SOCWriter {
    this.ensureReady()
    const signerObj = signer ? new PrivateKey(signer) : undefined
    const signerKey = signerObj ? signerObj.toHex() : undefined
    let owner: string | undefined = signerObj
      ? signerObj.publicKey().address().toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }

      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocGetOwnerResponseMessage,
        SocGetOwnerMessage
      >({
        type: "socGetOwner",
        requestId,
      })

      owner = response.owner
      return owner
    }

    const sendSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()

      const response = await this.sendRequest<
        SocDownloadResponseMessage,
        SocDownloadMessage
      >({
        type: "socDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    const sendRawSocDownload = async (
      identifier: Identifier | Uint8Array | string,
      encryptionKey?: Uint8Array | string,
    ): Promise<SingleOwnerChunk> => {
      const requestId = this.generateRequestId()

      const response = await this.sendRequest<
        SocRawDownloadResponseMessage,
        SocRawDownloadMessage
      >({
        type: "socRawDownload",
        requestId,
        owner,
        identifier: this.normalizeSocIdentifier(identifier),
        encryptionKey: encryptionKey
          ? this.normalizeSocKey(encryptionKey)
          : undefined,
        requestOptions,
      })

      return this.socChunkFromResponse(response)
    }

    const sendSocUpload = async (
      identifier: Identifier | Uint8Array | string,
      data: Uint8Array,
      options?: UploadOptions,
    ): Promise<SocUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocUploadResponseMessage,
        SocUploadMessage
      >({
        type: "socUpload",
        requestId,
        identifier: this.normalizeSocIdentifier(identifier),
        data: new Uint8Array(data),
        signer: signerKey,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        tagUid: response.tagUid,
        encryptionKey: response.encryptionKey,
        owner: response.owner,
      }
    }

    const sendRawSocUpload = async (
      identifier: Identifier | Uint8Array | string,
      data: Uint8Array,
      options?: UploadOptions,
    ): Promise<SocRawUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SocRawUploadResponseMessage,
        SocRawUploadMessage
      >({
        type: "socRawUpload",
        requestId,
        identifier: this.normalizeSocIdentifier(identifier),
        data: new Uint8Array(data),
        signer: signerKey,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        tagUid: response.tagUid,
        encryptionKey: response.encryptionKey,
        owner: response.owner,
      }
    }

    return {
      getOwner: resolveOwner,
      rawDownload: (identifier, encryptionKey) =>
        sendRawSocDownload(identifier, encryptionKey),
      download: (identifier, encryptionKey) =>
        sendSocDownload(identifier, encryptionKey),
      upload: (identifier, data, options) =>
        sendSocUpload(identifier, data, options),
      rawUpload: (identifier, data, options) =>
        sendRawSocUpload(identifier, data, options),
    }
  }

  /**
   * Returns an object for reading epoch-based feeds.
   *
   * @param options - Feed reader options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.owner - Optional feed owner address
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns FeedReader with `getOwner`, `downloadReference`, and `downloadPayload`
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   */
  makeEpochFeedReader(
    options: FeedReaderOptions,
    requestOptions?: RequestOptions,
  ): FeedReader {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    let owner: string | undefined = options.owner
      ? new EthAddress(options.owner).toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }

      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        FeedGetOwnerResponseMessage,
        FeedGetOwnerMessage
      >({
        type: "feedGetOwner",
        requestId,
      })

      owner = response.owner
      return owner
    }

    const downloadReference = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey:
          options?.encryptionKey !== undefined
            ? this.normalizeSocKey(options.encryptionKey)
            : undefined,
        requestOptions,
      })
      const reference = response.reference
      const cleanRef =
        reference && reference.startsWith("0x") ? reference.slice(2) : reference
      const encryptionKey =
        cleanRef && cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      return { reference, encryptionKey }
    }

    const downloadPayload = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: result.encryptionKey,
      }
    }

    const downloadRawReference = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey: undefined, // No encryption for raw download
        requestOptions,
      })
      const reference = response.reference
      return { reference, encryptionKey: undefined }
    }

    const downloadRawPayload = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadRawReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: undefined,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadReference,
      downloadPayload,
      downloadRawReference,
      downloadRawPayload,
    }
  }

  /**
   * Returns an object for reading and writing epoch-based feeds.
   *
   * @param options - Feed writer options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.signer - Optional feed signer private key. If omitted, the proxy uses the app signer.
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns FeedWriter with `getOwner`, `downloadReference`, `downloadPayload`, `uploadPayload`, and `uploadReference`
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the request times out
   */
  makeEpochFeedWriter(
    options: FeedWriterOptions,
    requestOptions?: RequestOptions,
  ): FeedWriter {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    const signerObj = options.signer
      ? new PrivateKey(options.signer)
      : undefined
    const signerKey = signerObj ? signerObj.toHex() : undefined
    let owner: string | undefined = signerObj
      ? signerObj.publicKey().address().toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }

      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        FeedGetOwnerResponseMessage,
        FeedGetOwnerMessage
      >({
        type: "feedGetOwner",
        requestId,
      })

      owner = response.owner
      return owner
    }

    const downloadReference = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey:
          options?.encryptionKey !== undefined
            ? this.normalizeSocKey(options.encryptionKey)
            : undefined,
        requestOptions,
      })
      const reference = response.reference
      const cleanRef =
        reference && reference.startsWith("0x") ? reference.slice(2) : reference
      const encryptionKey =
        cleanRef && cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      return { reference, encryptionKey }
    }

    const downloadPayload = async (
      options?: EpochFeedDownloadOptions,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: result.encryptionKey,
      }
    }

    const uploadReference = async (
      reference: Uint8Array | string,
      options?: EpochFeedUploadOptions,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const normalizedRef = this.normalizeReference(reference)
      const cleanRef = normalizedRef.startsWith("0x")
        ? normalizedRef.slice(2)
        : normalizedRef
      const derivedKey =
        cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      const feedKey = options?.encryptionKey ?? derivedKey
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: normalizedRef,
        encryptionKey:
          feedKey !== undefined ? this.normalizeSocKey(feedKey) : undefined,
        hints: options?.hints,
        batchID: options?.batchID ?? options?.uploadOptions?.batchID,
        requestOptions,
      })
      const socAddress = response.socAddress
      const encryptionKey = derivedKey
      return {
        socAddress,
        reference: normalizedRef,
        encryptionKey,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    const uploadPayload = async (
      data: Uint8Array | string,
      options?: EpochFeedUploadOptions,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const encrypt = options?.encrypt !== false
      // Payload and SOC go to one drive, whichever option named it.
      const batchID = options?.batchID ?? options?.uploadOptions?.batchID
      const uploadResult = await this.uploadData(
        this.normalizePayload(data),
        { ...options?.uploadOptions, encrypt, batchID },
        requestOptions,
      )
      const cleanRef = uploadResult.reference.startsWith("0x")
        ? uploadResult.reference.slice(2)
        : uploadResult.reference
      const derivedKey =
        cleanRef.length === 128 ? cleanRef.slice(64) : undefined
      const feedKey = options?.encryptionKey ?? derivedKey
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: uploadResult.reference,
        encryptionKey:
          feedKey !== undefined ? this.normalizeSocKey(feedKey) : undefined,
        hints: options?.hints,
        batchID,
        requestOptions,
      })
      const socAddress = response.socAddress
      const encryptionKey = derivedKey
      return {
        socAddress,
        reference: uploadResult.reference,
        encryptionKey,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    const downloadRawReference = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadReferenceResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedDownloadReferenceResponseMessage,
        EpochFeedDownloadReferenceMessage
      >({
        type: "epochFeedDownloadReference",
        requestId,
        topic,
        owner,
        at: this.normalizeFeedTimestamp(atValue),
        after:
          options?.after !== undefined
            ? this.normalizeFeedTimestamp(options.after)
            : undefined,
        encryptionKey: undefined, // No encryption for raw download
        requestOptions,
      })
      const reference = response.reference
      return { reference, encryptionKey: undefined }
    }

    const downloadRawPayload = async (
      options?: Omit<EpochFeedDownloadOptions, "encryptionKey">,
    ): Promise<EpochFeedDownloadPayloadResult> => {
      const result = await downloadRawReference(options)
      if (!result.reference) {
        return {
          reference: undefined,
          payload: undefined,
          encryptionKey: undefined,
        }
      }
      const payload = await this.downloadData(
        result.reference,
        undefined,
        requestOptions,
      )
      return {
        reference: result.reference,
        payload,
        encryptionKey: undefined,
      }
    }

    const uploadRawReference = async (
      reference: Uint8Array | string,
      options?: Omit<EpochFeedUploadOptions, "encryptionKey">,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      const normalizedRef = this.normalizeReference(reference)
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: normalizedRef,
        encryptionKey: undefined, // No encryption for raw upload
        hints: options?.hints,
        requestOptions,
      })
      const socAddress = response.socAddress
      return {
        socAddress,
        reference: normalizedRef,
        encryptionKey: undefined,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    const uploadRawPayload = async (
      data: Uint8Array | string,
      options?: Omit<EpochFeedUploadOptions, "encryptionKey" | "encrypt">,
    ): Promise<EpochFeedUploadResult> => {
      const atValue =
        options?.at !== undefined
          ? options.at
          : BigInt(Math.floor(Date.now() / 1000))
      // Upload with encrypt: false for raw payload
      const uploadResult = await this.uploadData(
        this.normalizePayload(data),
        { ...options?.uploadOptions, encrypt: false },
        requestOptions,
      )
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        EpochFeedUploadReferenceResponseMessage,
        EpochFeedUploadReferenceMessage
      >({
        type: "epochFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        at: this.normalizeFeedTimestamp(atValue),
        reference: uploadResult.reference,
        encryptionKey: undefined, // No encryption for raw upload
        hints: options?.hints,
        requestOptions,
      })
      const socAddress = response.socAddress
      return {
        socAddress,
        reference: uploadResult.reference,
        encryptionKey: undefined,
        epoch: response.epoch,
        timestamp: response.timestamp,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadReference,
      downloadPayload,
      downloadRawReference,
      downloadRawPayload,
      uploadReference,
      uploadPayload,
      uploadRawReference,
      uploadRawPayload,
    }
  }

  /**
   * Returns a sequential feed reader (chunk API only).
   *
   * @param options - Sequential feed reader options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.owner - Optional feed owner address
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns SequentialFeedReader with payload/reference download helpers
   */
  makeSequentialFeedReader(
    options: SequentialFeedReaderOptions,
    requestOptions?: RequestOptions,
  ): SequentialFeedReader {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    let owner: string | undefined = options.owner
      ? new EthAddress(options.owner).toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedGetOwnerResponseMessage,
        SequentialFeedGetOwnerMessage
      >({
        type: "seqFeedGetOwner",
        requestId,
      })
      owner = response.owner
      return owner
    }

    const downloadPayload = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadPayloadResponseMessage,
        SequentialFeedDownloadPayloadMessage
      >({
        type: "seqFeedDownloadPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadRawPayload = async (
      options?: SequentialFeedDownloadRawOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadRawPayloadResponseMessage,
        SequentialFeedDownloadRawPayloadMessage
      >({
        type: "seqFeedDownloadRawPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: options?.encryptionKey
          ? this.normalizeSocKey(options.encryptionKey)
          : undefined,
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadReference = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedReferenceResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadReferenceResponseMessage,
        SequentialFeedDownloadReferenceMessage
      >({
        type: "seqFeedDownloadReference",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadPayload,
      downloadRawPayload,
      downloadReference,
    }
  }

  /**
   * Returns a sequential feed writer (chunk API only).
   *
   * @param options - Sequential feed writer options
   * @param options.topic - Feed topic (32 bytes)
   * @param options.signer - Optional signer private key. If omitted, proxy uses app signer.
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns SequentialFeedWriter with payload/reference upload helpers
   */
  makeSequentialFeedWriter(
    options: SequentialFeedWriterOptions,
    requestOptions?: RequestOptions,
  ): SequentialFeedWriter {
    this.ensureReady()
    const topic = this.normalizeFeedTopic(options.topic)
    const signerObj = options.signer
      ? new PrivateKey(options.signer)
      : undefined
    const signerKey = signerObj ? signerObj.toHex() : undefined
    let owner: string | undefined = signerObj
      ? signerObj.publicKey().address().toHex()
      : undefined

    const resolveOwner = async (): Promise<string> => {
      if (owner) {
        return owner
      }
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedGetOwnerResponseMessage,
        SequentialFeedGetOwnerMessage
      >({
        type: "seqFeedGetOwner",
        requestId,
      })
      owner = response.owner
      return owner
    }

    const downloadPayload = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadPayloadResponseMessage,
        SequentialFeedDownloadPayloadMessage
      >({
        type: "seqFeedDownloadPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadRawPayload = async (
      options?: SequentialFeedDownloadRawOptions,
    ): Promise<SequentialFeedPayloadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadRawPayloadResponseMessage,
        SequentialFeedDownloadRawPayloadMessage
      >({
        type: "seqFeedDownloadRawPayload",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        encryptionKey: options?.encryptionKey
          ? this.normalizeSocKey(options.encryptionKey)
          : undefined,
        requestOptions,
      })

      return {
        payload: response.payload,
        timestamp: response.timestamp,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const downloadReference = async (
      encryptionKey: Uint8Array | string,
      options?: SequentialFeedUpdateOptions,
    ): Promise<SequentialFeedReferenceResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedDownloadReferenceResponseMessage,
        SequentialFeedDownloadReferenceMessage
      >({
        type: "seqFeedDownloadReference",
        requestId,
        topic,
        owner,
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        encryptionKey: this.normalizeSocKey(encryptionKey),
        requestOptions,
      })

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        feedIndexNext: response.feedIndexNext,
      }
    }

    const uploadPayload = async (
      data: Uint8Array | string,
      options?: SequentialFeedUploadOptions,
    ): Promise<SequentialFeedUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedUploadPayloadResponseMessage,
        SequentialFeedUploadPayloadMessage
      >({
        type: "seqFeedUploadPayload",
        requestId,
        topic,
        signer: signerKey,
        data: this.normalizePayload(data),
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        owner: response.owner,
        encryptionKey: response.encryptionKey,
        tagUid: response.tagUid,
      }
    }

    const uploadRawPayload = async (
      data: Uint8Array | string,
      options?: SequentialFeedUploadRawOptions,
    ): Promise<SequentialFeedUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedUploadRawPayloadResponseMessage,
        SequentialFeedUploadRawPayloadMessage
      >({
        type: "seqFeedUploadRawPayload",
        requestId,
        topic,
        signer: signerKey,
        data: this.normalizePayload(data),
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        encryptionKey: options?.encryptionKey
          ? this.normalizeSocKey(options.encryptionKey)
          : undefined,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        owner: response.owner,
        encryptionKey: response.encryptionKey,
        tagUid: response.tagUid,
      }
    }

    const uploadReference = async (
      reference: Uint8Array | string,
      options?: SequentialFeedUploadOptions,
    ): Promise<SequentialFeedUploadResult> => {
      const requestId = this.generateRequestId()
      const response = await this.sendRequest<
        SequentialFeedUploadReferenceResponseMessage,
        SequentialFeedUploadReferenceMessage
      >({
        type: "seqFeedUploadReference",
        requestId,
        topic,
        signer: signerKey,
        reference: this.normalizeReference(reference),
        index:
          options?.index !== undefined
            ? this.normalizeFeedIndex(options.index as bigint | number | string)
            : undefined,
        at:
          options?.at !== undefined
            ? this.normalizeFeedTimestamp(
                options.at as bigint | number | string,
              )
            : undefined,
        hasTimestamp: options?.hasTimestamp,
        lookupTimeoutMs: options?.lookupTimeoutMs,
        options,
        requestOptions,
      })

      owner = response.owner

      return {
        reference: response.reference,
        feedIndex: response.feedIndex,
        owner: response.owner,
        encryptionKey: response.encryptionKey,
        tagUid: response.tagUid,
      }
    }

    return {
      getOwner: resolveOwner,
      downloadPayload,
      downloadRawPayload,
      downloadReference,
      uploadPayload,
      uploadRawPayload,
      uploadReference,
    }
  }

  // ============================================================================
  // Feed Manifest Methods
  // ============================================================================

  /**
   * Creates a feed manifest for accessing feed content via URL.
   *
   * A feed manifest enables accessing the latest feed content via a URL path
   * (e.g., `/bzz/{manifest-reference}/`). The manifest stores metadata about
   * the feed including owner, topic, and type.
   *
   * @param topic - Feed topic (32-byte hex string)
   * @param options - Optional configuration
   * @param options.owner - Feed owner address; if omitted, uses app signer
   * @param options.uploadOptions - Upload configuration (pin, deferred, etc.)
   * @param requestOptions - Request configuration (timeout, headers). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns Promise resolving to the manifest reference
   * @throws {Error} If the client is not initialized
   * @throws {Error} If no owner is provided and no app signer is available
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // Create manifest for a feed (uses app signer as owner)
   * const manifestRef = await client.createFeedManifest(topic)
   * console.log('Feed accessible at /bzz/' + manifestRef)
   *
   * // Create manifest with explicit owner
   * const manifestRef = await client.createFeedManifest(topic, {
   *   owner: '0x1234...',
   * })
   * ```
   */
  async createFeedManifest(
    topic: string,
    options?: {
      owner?: string
      /** Feed type: "Sequence" for sequential feeds, "Epoch" for epoch feeds. Default: "Sequence" */
      feedType?: "Sequence" | "Epoch"
      uploadOptions?: UploadOptions
    },
    requestOptions?: RequestOptions,
  ): Promise<string> {
    this.ensureReady()
    const normalizedTopic = this.normalizeFeedTopic(topic)
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<
      CreateFeedManifestResponseMessage,
      CreateFeedManifestMessage
    >({
      type: "createFeedManifest",
      requestId,
      topic: normalizedTopic,
      owner: options?.owner,
      feedType: options?.feedType,
      uploadOptions: options?.uploadOptions,
      requestOptions,
    })

    return response.reference
  }

  // ============================================================================
  // GSOC Methods
  // ============================================================================

  /**
   * Mines a private key whose SOC address is proximate to a target overlay.
   *
   * This is a synchronous, pure computation that does not require authentication.
   * The mined signer can be used with {@link gsocSend} to send GSOC messages
   * that route to the target overlay node.
   *
   * @param targetOverlay - The target overlay address to mine proximity for
   * @param identifier - The GSOC identifier
   * @param proximity - Optional proximity depth (defaults to 12 in bee-js)
   * @returns A promise resolving to the mined signer as a hex string (private key)
   * @throws {Error} If the client is not initialized
   * @throws {Error} If no valid signer can be mined
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const signer = await client.gsocMine(targetOverlay, identifier)
   * // Use signer with gsocSend
   * await client.gsocSend(signer, identifier, data)
   * ```
   */
  async gsocMine(
    targetOverlay: string,
    identifier: string,
    proximity?: number,
  ): Promise<string> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "gsocMineResponse"
      requestId: string
      signer: string
    }>({
      type: "gsocMine",
      requestId,
      targetOverlay,
      identifier,
      proximity,
    })

    return response.signer
  }

  /**
   * Sends a GSOC (Global Single Owner Chunk) message using a mined signer.
   *
   * The signer should be obtained from {@link gsocMine}. The message is sent
   * using the proxy's stored postage batch ID.
   *
   * @param signer - The mined signer as a hex string (from gsocMine)
   * @param identifier - The GSOC identifier
   * @param data - The message data to send
   * @param options - Optional upload configuration
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the upload result with reference and optional tagUid
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated
   * @throws {Error} If no postage batch ID is available
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const signer = await client.gsocMine(targetOverlay, identifier)
   * const result = await client.gsocSend(signer, identifier, new TextEncoder().encode('Hello!'))
   * console.log('GSOC reference:', result.reference)
   * ```
   */
  async gsocSend(
    signer: string,
    identifier: string,
    data: Uint8Array,
    options?: UploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<UploadResult> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "gsocSendResponse"
      requestId: string
      reference: Reference
      tagUid?: number
    }>({
      type: "gsocSend",
      requestId,
      signer,
      identifier,
      data: new Uint8Array(data),
      options,
      requestOptions,
    })

    return {
      reference: response.reference,
      tagUid: response.tagUid,
    }
  }

  // ============================================================================
  // ACT (Access Control Tries) Methods
  // ============================================================================

  /**
   * Uploads data with ACT (Access Control Tries) protection.
   *
   * This method encrypts the data and creates an ACT that controls who can decrypt it.
   * Only the specified grantees (and the publisher) can decrypt and access the data.
   *
   * @param data - The binary data to upload as a Uint8Array
   * @param grantees - Array of grantee public keys as compressed hex strings (33 bytes = 66 hex chars).
   *   A grantee is either another user's `appKey.publicKey` (that user in this app origin only) or
   *   their `identity.sharingPublicKey` (that user in every app they connect, #519)
   * @param options - Optional upload configuration
   * @param options.publisher - `"app"` (default) publishes with this origin's app key; `"identity"`
   *   publishes with the account-wide sharing key, so any of the user's apps can manage the grantees later
   * @param options.pin - Whether to pin the data locally (defaults to false; ignored on a subsidised gateway)
   * @param options.tag - Tag ID for tracking upload progress
   * @param options.deferred - Whether to use deferred upload (defaults to false)
   * @param options.onProgress - Optional callback for tracking upload progress
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the ACT upload result
   * @returns return.encryptedReference - The encrypted reference that must be stored with the ACT
   * @returns return.actReference - The Swarm reference (hash) of the ACT manifest
   * @returns return.historyReference - The Swarm reference of the history manifest (use for future operations)
   * @returns return.granteeListReference - The Swarm reference of the encrypted grantee list
   * @returns return.publisherPubKey - The publisher's compressed public key (share with grantees)
   * @returns return.tagUid - The tag UID if a tag was created
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authenticated or cannot upload
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const data = new TextEncoder().encode('Secret message')
   * const grantees = ['03a1b2c3...'] // Compressed public keys of allowed readers
   * const result = await client.actUploadData(data, grantees, {
   *   onProgress: (progress) => {
   *     console.log(`Progress: ${progress.processed}/${progress.total}`)
   *   },
   * })
   * console.log('History Reference:', result.historyReference)
   * console.log('Encrypted Reference:', result.encryptedReference)
   * console.log('Publisher Public Key:', result.publisherPubKey)
   * ```
   */
  async actUploadData(
    data: Uint8Array,
    grantees: string[],
    options?: ActUploadOptions,
    requestOptions?: RequestOptions,
  ): Promise<{
    encryptedReference: string
    historyReference: string
    granteeListReference: string
    publisherPubKey: string
    actReference: string
    tagUid?: number
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()
    const { onProgress, ...serializableOptions } = options ?? {}

    const stopProgress = this.listenForProgress(requestId, onProgress)
    try {
      const response = await this.sendRequest<{
        type: "actUploadDataResponse"
        requestId: string
        encryptedReference: string
        historyReference: string
        granteeListReference: string
        publisherPubKey: string
        actReference: string
        tagUid?: number
      }>({
        type: "actUploadData",
        requestId,
        data: new Uint8Array(data),
        grantees,
        options: serializableOptions,
        requestOptions,
        enableProgress: !!onProgress,
      })

      return {
        encryptedReference: response.encryptedReference,
        historyReference: response.historyReference,
        granteeListReference: response.granteeListReference,
        publisherPubKey: response.publisherPubKey,
        actReference: response.actReference,
        tagUid: response.tagUid,
      }
    } finally {
      stopProgress()
    }
  }

  /**
   * Downloads ACT-protected data from the Swarm network.
   *
   * This method decrypts the ACT to recover the content reference,
   * then downloads and returns the decrypted data. Only authorized
   * grantees (including the publisher) can successfully decrypt.
   *
   * @param encryptedReference - The encrypted reference from actUploadData
   * @param historyReference - The history reference from actUploadData
   * @param publisherPubKey - The publisher's compressed public key from actUploadData
   * @param timestamp - Optional timestamp to look up a specific ACT version
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the decrypted data as a Uint8Array
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not authorized to decrypt the ACT
   * @throws {Error} If the references are not found
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * // Using the references from actUploadData
   * const data = await client.actDownloadData(
   *   encryptedReference,
   *   historyReference,
   *   publisherPubKey
   * )
   * const text = new TextDecoder().decode(data)
   * console.log('Decrypted:', text)
   * ```
   */
  async actDownloadData(
    encryptedReference: string,
    historyReference: string,
    publisherPubKey: string,
    timestamp?: number,
    requestOptions?: RequestOptions,
  ): Promise<Uint8Array> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actDownloadDataResponse"
      requestId: string
      data: Uint8Array
    }>({
      type: "actDownloadData",
      requestId,
      encryptedReference,
      historyReference,
      publisherPubKey,
      timestamp,
      requestOptions,
    })

    return response.data
  }

  /**
   * Adds new grantees to an existing ACT.
   *
   * This method adds new public keys to the ACT's access list.
   * Only the publisher (original uploader) can add grantees.
   * Returns new references since Swarm content is immutable.
   *
   * @param historyReference - The current history reference
   * @param grantees - Array of new grantee public keys as compressed hex strings
   * @param options - Optional `batchID`: the drive the new history and grantee list go to (#862)
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the new references
   * @returns return.historyReference - The new history reference after adding grantees
   * @returns return.granteeListReference - The new grantee list reference
   * @returns return.actReference - The new ACT reference
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not the publisher
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const newGrantees = ['03d4e5f6...'] // New public keys to grant access
   * const result = await client.actAddGrantees(historyReference, newGrantees)
   * console.log('New History Reference:', result.historyReference)
   * // The encrypted reference remains the same
   * ```
   */
  async actAddGrantees(
    historyReference: string,
    grantees: string[],
    options?: DriveTargetOptions,
    requestOptions?: RequestOptions,
  ): Promise<{
    historyReference: string
    granteeListReference: string
    actReference: string
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actAddGranteesResponse"
      requestId: string
      historyReference: string
      granteeListReference: string
      actReference: string
    }>({
      type: "actAddGrantees",
      requestId,
      historyReference,
      grantees,
      batchID: options?.batchID,
      requestOptions,
    })

    return {
      historyReference: response.historyReference,
      granteeListReference: response.granteeListReference,
      actReference: response.actReference,
    }
  }

  /**
   * Revokes grantees from an existing ACT.
   *
   * This method removes public keys from the ACT's access list, producing a new
   * ACT/history without the revoked entries.
   *
   * IMPORTANT: Revocation cannot un-share already-published content. A former
   * grantee kept the access key while granted and the reference lives in
   * immutable history, so they can still decrypt content published before
   * revocation. Revocation only stops access to content published afterwards.
   * The returned `encryptedReference` is unchanged — it is NOT re-encrypted, as
   * that would leak the keystream to former grantees (#496).
   *
   * @param historyReference - The current history reference
   * @param encryptedReference - The current encrypted reference
   * @param revokeGrantees - Array of grantee public keys to revoke as compressed hex strings
   * @param options - Optional `batchID`: the drive the rotated history goes to (#862)
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to the new references after revocation
   * @returns return.encryptedReference - The content reference, unchanged
   * @returns return.historyReference - The new history reference after revocation
   * @returns return.granteeListReference - The new grantee list reference
   * @returns return.actReference - The new ACT reference after revocation
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not the publisher
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const revokeKeys = ['03a1b2c3...'] // Public keys to revoke
   * const result = await client.actRevokeGrantees(historyReference, encryptedReference, revokeKeys)
   * console.log('New History Reference:', result.historyReference)
   * // encryptedReference is unchanged; historyReference/actReference are new
   * ```
   */
  async actRevokeGrantees(
    historyReference: string,
    encryptedReference: string,
    revokeGrantees: string[],
    options?: DriveTargetOptions,
    requestOptions?: RequestOptions,
  ): Promise<{
    encryptedReference: string
    historyReference: string
    granteeListReference: string
    actReference: string
  }> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actRevokeGranteesResponse"
      requestId: string
      encryptedReference: string
      historyReference: string
      granteeListReference: string
      actReference: string
    }>({
      type: "actRevokeGrantees",
      requestId,
      historyReference,
      encryptedReference,
      revokeGrantees,
      batchID: options?.batchID,
      requestOptions,
    })

    return {
      encryptedReference: response.encryptedReference,
      historyReference: response.historyReference,
      granteeListReference: response.granteeListReference,
      actReference: response.actReference,
    }
  }

  /**
   * Retrieves the list of grantees from an ACT.
   *
   * Only the publisher (original uploader) can view the grantee list,
   * as it is encrypted with the publisher's key.
   *
   * @param historyReference - The history reference
   * @param requestOptions - Optional request configuration (timeout, headers, endlesslyRetry). `timeout` replaces the client default for this call's whole round trip, not only the Bee request
   * @returns A promise resolving to an array of grantee public keys as compressed hex strings
   * @throws {Error} If the client is not initialized
   * @throws {Error} If the user is not the publisher
   * @throws {Error} If the request times out
   *
   * @example
   * ```typescript
   * const grantees = await client.actGetGrantees(historyReference)
   * console.log('Current grantees:', grantees.length)
   * grantees.forEach(pubKey => console.log('  -', pubKey))
   * ```
   */
  async actGetGrantees(
    historyReference: string,
    requestOptions?: RequestOptions,
  ): Promise<string[]> {
    this.ensureReady()
    const requestId = this.generateRequestId()

    const response = await this.sendRequest<{
      type: "actGetGranteesResponse"
      requestId: string
      grantees: string[]
    }>({
      type: "actGetGrantees",
      requestId,
      historyReference,
      requestOptions,
    })

    return response.grantees
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Destroys the client and releases all resources.
   *
   * This method should be called when the client is no longer needed.
   * It performs the following cleanup:
   * - Rejects every pending request, and a pending `initialize()`, with a
   *   `SwarmIdError` of code `invalid-state`
   * - Removes the message event listener
   * - Removes the iframe from the DOM
   * - Resets the client to an uninitialized state
   *
   * After calling destroy(), the client instance cannot be reused.
   * Create a new instance if you need to reconnect.
   *
   * @example
   * ```typescript
   * // Clean up when component unmounts
   * useEffect(() => {
   *   const client = new SwarmIdClient({ ... })
   *   client.initialize()
   *
   *   return () => {
   *     client.destroy()
   *   }
   * }, [])
   * ```
   */
  destroy(): void {
    this.teardown()
  }

  /** `destroy()`, minus the promise never to come back: `useIdentitySite` re-initializes after it. */
  private teardown(): void {
    const destroyed = () =>
      new SwarmIdError("invalid-state", "Client destroyed")

    // Clear pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId)
      pending.reject(destroyed())
    })
    this.pendingRequests.clear()
    this.progressListeners.clear()

    // Remove message listener
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener)
      this.messageListener = undefined
    }

    // Remove iframe. Dropped even when it was never attached: `initialize()`
    // reads a held iframe as "already initialized", so keeping one here would
    // refuse the re-initialize `useIdentitySite` runs next.
    if (this.iframe) {
      this.iframe.parentNode?.removeChild(this.iframe)
      this.iframe = undefined
    }

    // Reject every still-pending init wait. Whichever one `initialize()` is
    // awaiting rejects it, so a destroy mid-initialize settles it instead of
    // leaving it on an iframe that will never load or a proxy that is gone;
    // and the deadline-bound ones clear their `withTimeout` timers now
    // instead of lingering the full initializationTimeout. The
    // `.catch(() => {})` guards attached in initialize() keep these from
    // surfacing as unhandled when nothing is awaiting.
    this.iframeLoadReject?.(destroyed())
    this.proxyInitializedReject?.(destroyed())
    this.readyReject?.(destroyed())
    this.firstConnectionInfoReject?.(destroyed())
    this.iframeLoadReject = undefined
    this.readyResolve = undefined
    this.readyReject = undefined
    this.proxyInitializedResolve = undefined
    this.proxyInitializedReject = undefined
    this.firstConnectionInfoResolve = undefined
    this.firstConnectionInfoReject = undefined
    this.readyPromise = undefined
    this.proxyInitializedPromise = undefined
    this.firstConnectionInfoPromise = undefined

    this.ready = false
  }
}
