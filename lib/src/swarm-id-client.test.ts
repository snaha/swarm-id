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

  it("should send agent flag to proxy when agent option is true", async () => {
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

  it("should throw error if client is not initialized", async () => {
    await expect(client.connect()).rejects.toThrow(
      "SwarmIdClient not initialized. Call initialize() first.",
    )
  })
})
