import { describe, it, expect, vi, beforeEach } from "vitest"
import { SwarmIdClient } from "./swarm-id-client"

describe("SwarmIdClient connect()", () => {
  let client: SwarmIdClient
  let mockWindow: Record<string, unknown>

  beforeEach(() => {
    mockWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      parent: { postMessage: vi.fn() },
      location: { origin: "https://localhost" },
      open: vi.fn().mockReturnValue({}),
    }

    vi.stubGlobal("window", mockWindow)
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" })
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

  it("should send storeChallenge and open popup with correct URL", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    const sendMessageSpy = vi
      .spyOn(client as never, "sendMessage")
      .mockImplementation(() => {})

    client.connect()

    expect(sendMessageSpy).toHaveBeenCalledWith({
      type: "storeChallenge",
      challenge: "test-uuid",
    })

    expect(mockWindow.open).toHaveBeenCalledWith(
      expect.stringContaining("https://swarm-id.example.com/connect#"),
      "_blank",
    )

    const url = (mockWindow.open as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(url).toContain("origin=")
    expect(url).toContain("challenge=test-uuid")
    expect(url).toContain("appName=Test+App")
  })

  it("should include agent flag in URL", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    vi.spyOn(client as never, "sendMessage").mockImplementation(() => {})

    client.connect({ agent: true })

    const url = (mockWindow.open as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(url).toContain("agent=")
  })

  it("should throw when popup is blocked", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    vi.spyOn(client as never, "sendMessage").mockImplementation(() => {})
    ;(mockWindow.open as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

    expect(() => client.connect()).toThrow(
      "Failed to open authentication popup",
    )
  })

  it("should open popup with features string when popupMode is popup", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})
    vi.spyOn(client as never, "sendMessage").mockImplementation(() => {})

    client.connect({ popupMode: "popup" })

    expect(mockWindow.open).toHaveBeenCalledWith(
      expect.stringContaining("https://swarm-id.example.com/connect#"),
      "_blank",
      "width=500,height=600",
    )
  })

  it("should throw error if client is not initialized", () => {
    expect(() => client.connect()).toThrow(
      "SwarmIdClient not initialized. Call initialize() first.",
    )
  })
})
