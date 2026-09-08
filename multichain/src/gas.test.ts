// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest"
import { withGasMargin } from "./gas"

describe("withGasMargin", () => {
  it("adds 25% headroom, rounding down", () => {
    expect(withGasMargin(1_000_000n)).toBe(1_250_000n)
    expect(withGasMargin(7n)).toBe(8n)
  })
})
