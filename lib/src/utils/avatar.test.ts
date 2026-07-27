// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"

import { generatedAvatar, generatedAvatarSvg } from "./avatar"

// Expected markup is pinned verbatim rather than recomputed: the avatar a dApp
// renders must stay pixel-identical to the one Swarm ID's own UI shows for the
// same account, so any change to the algorithm has to fail here.
const SEED = "0000000000000000000000000000000000000001"
const SEED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
  '<rect width="40" height="40" fill="#131416"/>' +
  '<path d="M20,20 h10 v10 h-10z M10,20 h10 v10 h-10z M10,10 h10 v10 h-10z M20,10 h10 v10 h-10z " fill="#9C27B0"/></svg>'

describe("generatedAvatarSvg", () => {
  it("renders the pinned markup for a known seed", () => {
    expect(generatedAvatarSvg(SEED)).toBe(SEED_SVG)
  })

  it("defaults to 40px", () => {
    expect(generatedAvatarSvg(SEED)).toBe(generatedAvatarSvg(SEED, 40))
  })

  it("scales geometry with the requested size", () => {
    expect(generatedAvatarSvg("abc", 32)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" fill="#DD7200"/>' +
        '<path d="M24,16 v8 h-8z M16,16 v-8 h8z M16,16 h-8 v-8z M16,16 v8 h-8z " fill="#FFE0CC"/></svg>',
    )
  })

  it("is deterministic", () => {
    expect(generatedAvatarSvg(SEED)).toBe(generatedAvatarSvg(SEED))
  })

  it("gives different accounts different avatars", () => {
    const avatars = new Set(
      Array.from({ length: 64 }, (_, i) =>
        generatedAvatarSvg(i.toString(16).padStart(40, "0")),
      ),
    )
    // Collisions are expected from a 2×2 grid, but the seeds must not all
    // collapse onto one image.
    expect(avatars.size).toBeGreaterThan(16)
  })

  it("pads short seeds instead of degenerating", () => {
    expect(generatedAvatarSvg("a")).toBe(generatedAvatarSvg("a     "))
    expect(generatedAvatarSvg("")).not.toBe(generatedAvatarSvg("a"))
  })

  it("emits a single well-formed rect and path", () => {
    const svg = generatedAvatarSvg("well-formed")
    expect(svg.match(/<rect /g)).toHaveLength(1)
    expect(svg.match(/<path /g)).toHaveLength(1)
    expect(svg.endsWith("</svg>")).toBe(true)
  })
})

describe("generatedAvatar", () => {
  it("reports where the image came from", () => {
    expect(generatedAvatar(SEED).source).toBe("generated")
  })

  it("wraps the same markup in a renderable data URL", () => {
    const { url } = generatedAvatar(SEED)
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
    expect(decodeURIComponent(url.split(",").slice(1).join(","))).toBe(SEED_SVG)
  })

  it("percent-encodes the characters that would break an img src", () => {
    const { url } = generatedAvatar(SEED)
    expect(url).not.toContain("#")
    expect(url).not.toContain('"')
    expect(url).not.toContain("<")
  })

  it("honours the requested size", () => {
    const { url } = generatedAvatar("abc", 32)
    expect(decodeURIComponent(url)).toContain('width="32"')
  })
})
