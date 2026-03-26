import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmIdClient } from "./swarm-id-client"

describe("SwarmIdClient connect()", () => {
  let client: SwarmIdClient

  beforeEach(() => {
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
    })

    client = new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: {
        name: "Test App",
        description: "A test application",
      },
    })
  })

  it("should send generateChallenge and open popup from parent when storage is not partitioned", async () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    const sendRequestSpy = vi
      .spyOn(client as never, "sendRequest")
      .mockResolvedValue({
        type: "generateChallengeResponse",
        requestId: "test",
        authUrl:
          "https://swarm-id.example.com/connect#origin=https%3A%2F%2Flocalhost",
      })

    await client.connect()

    expect(sendRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "generateChallenge",
        agent: undefined,
      }),
    )
    expect(window.open).toHaveBeenCalledWith(
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Flocalhost",
      "_blank",
    )
  })

  it("should send agent flag in generateChallenge when agent option is true", async () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    const sendRequestSpy = vi
      .spyOn(client as never, "sendRequest")
      .mockResolvedValue({
        type: "generateChallengeResponse",
        requestId: "test",
        authUrl: "https://swarm-id.example.com/connect#origin=test&agent=",
      })

    await client.connect({ agent: true })

    expect(sendRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "generateChallenge",
        agent: true,
      }),
    )
  })

  it("should send connect message to proxy when storage is partitioned", async () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    // Simulate storagePartitioned = true by triggering handleIframeMessage
    ;(client as never)["storagePartitioned"] = true
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

  it("should throw when popup fails to open in partitioned mode", async () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    ;(client as never)["storagePartitioned"] = true
    vi.spyOn(client as never, "sendRequest").mockResolvedValue({
      type: "connectResponse",
      requestId: "test",
      success: false,
    })

    await expect(client.connect()).rejects.toThrow(
      "Failed to open authentication popup",
    )
  })

  it("should throw error if client is not initialized", async () => {
    await expect(client.connect()).rejects.toThrow(
      "SwarmIdClient not initialized. Call initialize() first.",
    )
  })
})
