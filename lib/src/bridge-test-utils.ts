// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A real `SwarmIdClient` wired to a real `SwarmIdProxy` over the two
 * `postMessage` seams, for tests: each message is run through
 * `structuredClone` with its transfer list and validated by the receiving
 * side's schema, as the browser would. Only the Bee node is a stand-in.
 *
 * A test file using it mocks `virtual:stamp-worker-code` itself: `vi.mock` is
 * hoisted per test file.
 */

import { vi } from "vitest"
import { Binary } from "cafe-utility"
import { SwarmIdClient } from "./swarm-id-client"
import { SwarmIdProxy } from "./swarm-id-proxy"
import {
  IframeToParentMessageSchema,
  type IframeToParentMessage,
} from "./types"
import { calculateChunkAddress } from "./chunk"
import { MockBee, MockChunkStore } from "./proxy/feeds/epochs/test-utils"

export const BRIDGE_GATEWAY_URL = "https://gateway.example.com"
const PARENT_ORIGIN = "https://dapp.example.com"
const IFRAME_ORIGIN = "https://id.example.com"
const APP_SECRET_HEX = "ab".repeat(32)
/** Beyond what any test needs to finish; expiry shows as a failure. */
const GENEROUS_TIMEOUT_MS = 60_000

/** The stand-in gateway's behaviour, for a test to change as it runs. */
export interface BridgeGateway {
  /** Hold every chunk until its request's signal aborts. */
  hangs: boolean
  /** Called with each chunk's position, from 1: the chunk waits on what it returns. */
  hold?: (chunkNumber: number) => Promise<void> | void
}

export interface Bridge {
  client: SwarmIdClient
  proxy: SwarmIdProxy
  store: MockChunkStore
  bee: MockBee
  /** The gateway's `fetch`: one call per chunk a subsidised upload sends. */
  fetchSpy: ReturnType<typeof vi.fn>
  gateway: BridgeGateway
  /** Hands a message to the proxy as if the parent posted it. */
  sendToProxy: (data: unknown) => Promise<void>
}

/**
 * Open a connected, authenticated client and proxy pair whose uploads go to a
 * stand-in subsidised gateway. Stubs `fetch` and `window`: the caller undoes
 * both with `vi.unstubAllGlobals()`.
 */
export async function openBridge(): Promise<Bridge> {
  const store = new MockChunkStore()
  const bee = new MockBee(store)
  const gateway: BridgeGateway = { hangs: false }

  const fetchSpy = vi.fn(
    async (_url: string, init: RequestInit): Promise<Response> => {
      if (gateway.hangs) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        })
      }
      await gateway.hold?.(fetchSpy.mock.calls.length)
      const body = init.body as Uint8Array
      const reference = Binary.uint8ArrayToHex(
        calculateChunkAddress(body).toUint8Array(),
      )
      await store.put(reference, body)
      return new Response(JSON.stringify({ reference }))
    },
  )
  vi.stubGlobal("fetch", fetchSpy)

  const clientInternals = () =>
    client as unknown as {
      ready: boolean
      iframe: unknown
      handleIframeMessage: (message: IframeToParentMessage) => void
    }
  const listeners: Record<string, unknown> = {}
  const parentWindow = {
    postMessage: (
      message: { type: string },
      options: string | StructuredSerializeOptions,
    ) => {
      // Announced to `"*"` before a client exists; nothing here needs it.
      if (typeof options === "string") return
      const data = structuredClone(message, options)
      queueMicrotask(() =>
        clientInternals().handleIframeMessage(
          IframeToParentMessageSchema.parse(data),
        ),
      )
    },
  }
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, listener: unknown) => {
      listeners[type] = listener
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    parent: parentWindow,
    location: { origin: IFRAME_ORIGIN, pathname: "/proxy" },
  })
  const client = new SwarmIdClient({
    iframeOrigin: IFRAME_ORIGIN,
    metadata: { name: "Test App" },
    timeout: GENEROUS_TIMEOUT_MS,
  })
  const proxy = new SwarmIdProxy()
  const toProxy = listeners["message"] as (event: unknown) => Promise<void>
  const sendToProxy = (data: unknown) =>
    toProxy({ data, origin: PARENT_ORIGIN, source: parentWindow })

  await sendToProxy({
    type: "parentIdentify",
    requestId: "r1",
    metadata: { name: "Test App" },
    subsidisedGatewayUrl: BRIDGE_GATEWAY_URL,
  })
  const proxyInternals = proxy as unknown as {
    authenticated: boolean
    appSecret: string
  }
  proxyInternals.authenticated = true
  proxyInternals.appSecret = APP_SECRET_HEX
  Object.defineProperty(proxy, "bee", { value: bee })

  clientInternals().ready = true
  clientInternals().iframe = {
    contentWindow: {
      postMessage: (
        message: unknown,
        _origin: string,
        transfer?: Transferable[],
      ) => void sendToProxy(structuredClone(message, { transfer })),
    },
  }

  return { client, proxy, store, bee, fetchSpy, gateway, sendToProxy }
}
