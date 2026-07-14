// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest"

// Rollup-only virtual module (see rollup.config.js) — not resolvable in vitest
vi.mock("virtual:stamp-worker-code", () => ({ default: "" }))

import { SwarmIdProxy } from "./swarm-id-proxy"

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
