// Copyright 2024 The Swarm Authors. All rights reserved.
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

    it("should include agent param in auth URL", async () => {
      vi.spyOn(client, "ensureReady").mockImplementation(() => {})

      await client.connect({ agent: true })

      expect(window.open).toHaveBeenCalledWith(
        expect.stringContaining("agent="),
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
          agent: undefined,
        }),
      )
    })

    it("should send agent flag to proxy", async () => {
      vi.spyOn(client, "ensureReady").mockImplementation(() => {})
      const sendRequestSpy = vi
        .spyOn(client as never, "sendRequest")
        .mockResolvedValue({
          type: "connectResponse",
          requestId: "test",
          success: true,
        })

      await client.connect({ agent: true })

      expect(sendRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "connect",
          agent: true,
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
