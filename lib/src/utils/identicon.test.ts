// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest"

import { identiconSvg } from "./identicon"

// Expected markup is pinned verbatim rather than recomputed: the icon a dApp
// renders must stay pixel-identical to the one Swarm ID's own UI shows for the
// same account, so any change to the algorithm has to fail here.
const SEED = "0000000000000000000000000000000000000001"
const SEED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
  '<rect width="40" height="40" fill="#131416"/>' +
  '<path d="M20,20 h10 v10 h-10z M10,20 h10 v10 h-10z M10,10 h10 v10 h-10z M20,10 h10 v10 h-10z " fill="#9C27B0"/></svg>'

describe("identiconSvg", () => {
  it("renders the pinned markup for a known seed", () => {
    expect(identiconSvg(SEED)).toBe(SEED_SVG)
  })

  it("defaults to 40px", () => {
    expect(identiconSvg(SEED)).toBe(identiconSvg(SEED, 40))
  })

  it("scales geometry with the requested size", () => {
    expect(identiconSvg("abc", 32)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" fill="#DD7200"/>' +
        '<path d="M24,16 v8 h-8z M16,16 v-8 h8z M16,16 h-8 v-8z M16,16 v8 h-8z " fill="#FFE0CC"/></svg>',
    )
  })

  it("is deterministic", () => {
    expect(identiconSvg(SEED)).toBe(identiconSvg(SEED))
  })

  it("gives different accounts different icons", () => {
    const icons = new Set(
      Array.from({ length: 64 }, (_, i) =>
        identiconSvg(i.toString(16).padStart(40, "0")),
      ),
    )
    // Collisions are expected from a 2×2 grid, but the seeds must not all
    // collapse onto one icon.
    expect(icons.size).toBeGreaterThan(16)
  })

  it("pads short seeds instead of degenerating", () => {
    expect(identiconSvg("a")).toBe(identiconSvg("a     "))
    expect(identiconSvg("")).not.toBe(identiconSvg("a"))
  })

  it("emits a single well-formed rect and path", () => {
    const svg = identiconSvg("well-formed")
    expect(svg.match(/<rect /g)).toHaveLength(1)
    expect(svg.match(/<path /g)).toHaveLength(1)
    expect(svg.endsWith("</svg>")).toBe(true)
  })
})
