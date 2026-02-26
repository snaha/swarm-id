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

  it("should build correct authentication URL with metadata", () => {
    // Mock ensureReady to bypass initialization requirement
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})

    const expectedUrl =
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Flocalhost&appName=Test+App&appDescription=A+test+application"

    const openedUrl = client.connect()

    expect(window.open).toHaveBeenCalledWith(expectedUrl, "_blank")
    expect(openedUrl).toBe(expectedUrl)
  })

  it("should open popup window when popupMode is 'popup'", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})

    client.connect({ popupMode: "popup" })

    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining("connect#"),
      "_blank",
      "width=500,height=600",
    )
  })

  it("should open full window when popupMode is 'window'", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})

    client.connect({ popupMode: "window" })

    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining("connect#"),
      "_blank",
    )
  })

  it("should include agent parameter when agent option is true", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})

    const openedUrl = client.connect({ agent: true })

    expect(openedUrl).toContain("agent=")
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining("agent="),
      "_blank",
    )
  })

  it("should not include agent parameter when agent option is false or not set", () => {
    vi.spyOn(client, "ensureReady").mockImplementation(() => {})

    const openedUrl = client.connect()

    expect(openedUrl).not.toContain("agent")
  })

  it("should work with minimal metadata", () => {
    const clientWithMinimalMetadata = new SwarmIdClient({
      iframeOrigin: "https://swarm-id.example.com",
      metadata: {
        name: "Minimal App",
      },
    })

    vi.spyOn(clientWithMinimalMetadata, "ensureReady").mockImplementation(
      () => {},
    )

    const expectedUrl =
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Flocalhost&appName=Minimal+App"
    const openedUrl = clientWithMinimalMetadata.connect()

    expect(window.open).toHaveBeenCalledWith(expectedUrl, "_blank")
    expect(openedUrl).toBe(expectedUrl)
  })

  it("should throw error if client is not initialized", () => {
    expect(() => client.connect()).toThrow(
      "SwarmIdClient not initialized. Call initialize() first.",
    )
  })
})
