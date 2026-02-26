import { describe, it, expect } from "vitest"
import { buildAuthUrl } from "./url"

describe("buildAuthUrl", () => {
  it("should build URL with origin only", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
    )

    expect(url).toBe(
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Fmyapp.example.com",
    )
  })

  it("should build URL with origin and minimal metadata", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      {
        name: "Test App",
      },
    )

    expect(url).toBe(
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Fmyapp.example.com&appName=Test+App",
    )
  })

  it("should build URL with origin and full metadata", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      {
        name: "Test App",
        description: "A test application",
        icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiPjwvc3ZnPg==",
      },
    )

    const expectedUrl =
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Fmyapp.example.com&appName=Test+App&appDescription=A+test+application&appIcon=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiPjwvc3ZnPg%3D%3D"
    expect(url).toBe(expectedUrl)
  })

  it("should properly encode URL parameters", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://my-app.example.com/path?query=value",
      {
        name: "My App & Co.",
        description: "An app with special chars: äöü",
      },
    )

    expect(url).toContain(
      "origin=https%3A%2F%2Fmy-app.example.com%2Fpath%3Fquery%3Dvalue",
    )
    expect(url).toContain("appName=My+App+%26+Co.")
    expect(url).toContain(
      "appDescription=An+app+with+special+chars%3A+%C3%A4%C3%B6%C3%BC",
    )
  })

  it("should handle empty description and icon", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      {
        name: "Test App",
        description: "",
        icon: "",
      },
    )

    // URLSearchParams omits empty strings, so only origin and appName should be included
    expect(url).toBe(
      "https://swarm-id.example.com/connect#origin=https%3A%2F%2Fmyapp.example.com&appName=Test+App",
    )
  })

  it("should include proxyMode when option is true", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      { name: "Test App" },
      { proxyMode: true },
    )

    expect(url).toContain("proxyMode=true")
  })

  it("should include agent parameter when option is true", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      { name: "Test App" },
      { agent: true },
    )

    expect(url).toContain("agent=")
  })

  it("should not include agent parameter when option is false", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      { name: "Test App" },
      { agent: false },
    )

    expect(url).not.toContain("agent")
  })

  it("should include both proxyMode and agent when both options are true", () => {
    const url = buildAuthUrl(
      "https://swarm-id.example.com",
      "https://myapp.example.com",
      { name: "Test App" },
      { proxyMode: true, agent: true },
    )

    expect(url).toContain("proxyMode=true")
    expect(url).toContain("agent=")
  })
})
